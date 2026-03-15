/**
 * Surgical parcel repair script.
 *
 * For bitmaps that have both valid AND invalid parcels, check whether any
 * (bitmap_number, parcel_number) slot currently held by an INVALID parcel
 * should actually belong to a real child inscription that was rejected during
 * the unvalidated initial index (first-is-first dedup).
 *
 * Steps per bitmap:
 *   1. Fetch children set via /r/children/{bitmap_inscription_id}
 *   2. Identify children NOT already stored as valid parcels in DB
 *   3. Fetch each unknown child's content from ord
 *   4. Parse content — is it a parcel claim for this bitmap?
 *   5. If the claimed slot is held by an invalid row → replace it
 *
 * Usage:
 *   cd server && npx ts-node src/tools/repairParcels.ts [--dry-run]
 */
import 'dotenv/config';

import axios from 'axios';
import { setupDatabase, db as getDb } from '../db/database';
import logger from '../utils/logger';

const ORD_API_URL = process.env.API_URL || 'http://127.0.0.1:4000';
const DRY_RUN = process.argv.includes('--dry-run');

interface ParcelRow {
  inscription_id: string;
  parcel_number: number;
  bitmap_number: number;
  block_height: number;
  inscription_index: number;
  is_valid: number;
  current_wallet: string;
  content: string;
}

/* ── helpers ──────────────────────────────────────────────── */

/** Paginated fetch of all children inscription IDs. */
const fetchChildrenSet = async (parentId: string): Promise<Set<string>> => {
  const ids: string[] = [];
  let page = 0;
  while (true) {
    const url =
      page === 0
        ? `${ORD_API_URL}/r/children/${parentId}`
        : `${ORD_API_URL}/r/children/${parentId}/${page}`;
    const res = await axios.get(url, {
      headers: { Accept: 'application/json,*/*' },
      timeout: 15000,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const pageIds: string[] = Array.isArray((res.data as any)?.ids)
      ? (res.data as any).ids
      : [];
    ids.push(...pageIds.map((s) => String(s).toLowerCase()));
    const more = !!(res.data as any)?.more;
    if (!more || pageIds.length === 0) break;
    page++;
    if (page > 2000) throw new Error('children pagination runaway');
  }
  return new Set(ids);
};

/** Fetch inscription details (content, block_height, etc.) from ord. */
const fetchInscriptionInfo = async (
  inscriptionId: string,
): Promise<{
  content: string | null;
  block_height: number;
  inscription_index: number;
  address: string;
} | null> => {
  try {
    // First get the inscription metadata
    const metaRes = await axios.get(`${ORD_API_URL}/inscription/${inscriptionId}`, {
      headers: { Accept: 'application/json' },
      timeout: 15000,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const meta = metaRes.data as any;
    const block_height: number = meta?.genesis_height ?? meta?.height ?? 0;
    const inscription_index: number = meta?.number ?? meta?.inscription_number ?? 0;
    const address: string = meta?.address ?? '';

    // Fetch content
    const contentRes = await axios.get(`${ORD_API_URL}/content/${inscriptionId}`, {
      timeout: 15000,
      responseType: 'text',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const content = typeof contentRes.data === 'string' ? contentRes.data.trim() : null;

    return { content, block_height, inscription_index, address };
  } catch (err: any) {
    logger.warn(`Failed to fetch inscription ${inscriptionId}: ${err?.message}`);
    return null;
  }
};

/** Parse parcel content — returns null if not a valid parcel claim. */
const parseParcelContent = (
  content: string,
): { parcelNumber: number; bitmapNumber: number } | null => {
  const parts = content.trim().split('.');
  if (parts.length !== 3 || parts[2] !== 'bitmap') return null;
  const parcelNumber = Number.parseInt(parts[0], 10);
  const bitmapNumber = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(parcelNumber) || !Number.isFinite(bitmapNumber)) return null;
  if (parcelNumber < 0 || bitmapNumber < 0) return null;
  return { parcelNumber, bitmapNumber };
};

/* ── main ─────────────────────────────────────────────────── */

const main = async () => {
  logger.info(`=== Parcel Repair Script ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  await setupDatabase();
  const db = getDb;
  if (!db) throw new Error('Database not initialized');

  // 1. Find bitmaps with BOTH valid and invalid parcels
  const overlaps = await db.all<
    { bitmap_number: number; valid_cnt: number; invalid_cnt: number }[]
  >(`
    SELECT bitmap_number,
      SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid_cnt,
      SUM(CASE WHEN is_valid = 0 THEN 1 ELSE 0 END) as invalid_cnt
    FROM parcels
    GROUP BY bitmap_number
    HAVING valid_cnt > 0 AND invalid_cnt > 0
    ORDER BY bitmap_number
  `);

  logger.info(`Found ${overlaps.length} bitmaps with both valid + invalid parcels`);

  let totalRepaired = 0;
  let totalChecked = 0;
  let totalChildrenFetched = 0;

  for (const ov of overlaps) {
    const { bitmap_number: bm, valid_cnt, invalid_cnt } = ov;
    logger.info(`\n── Bitmap ${bm}: valid=${valid_cnt} invalid=${invalid_cnt} ──`);

    // Get bitmap inscription_id
    const bitmapRow = await db.get<{ inscription_id: string; block_height: number }>(
      'SELECT inscription_id, block_height FROM bitmaps WHERE bitmap_number = ?',
      bm,
    );
    if (!bitmapRow) {
      logger.warn(`  Bitmap ${bm} not in bitmaps table — skip`);
      continue;
    }

    // Get invalid parcel rows for this bitmap
    const invalidParcels = await db.all<ParcelRow[]>(
      'SELECT * FROM parcels WHERE bitmap_number = ? AND is_valid = 0',
      bm,
    );
    // Map: parcel_number → invalid row
    const invalidSlots = new Map<number, ParcelRow>();
    for (const p of invalidParcels) invalidSlots.set(p.parcel_number, p);

    // Get valid parcel inscription_ids we already know about
    const validParcels = await db.all<{ inscription_id: string }[]>(
      'SELECT inscription_id FROM parcels WHERE bitmap_number = ? AND is_valid = 1',
      bm,
    );
    const knownValidIds = new Set(validParcels.map((p) => p.inscription_id.toLowerCase()));

    // Fetch children set for this bitmap
    let childrenSet: Set<string>;
    try {
      childrenSet = await fetchChildrenSet(bitmapRow.inscription_id);
    } catch (err: any) {
      logger.warn(`  Failed to fetch children for bitmap ${bm}: ${err?.message} — skip`);
      continue;
    }
    logger.info(`  Children of bitmap ${bm}: ${childrenSet.size}`);

    // Find children NOT already stored as valid
    const unknownChildren = [...childrenSet].filter((id) => !knownValidIds.has(id));
    logger.info(`  Unknown children to inspect: ${unknownChildren.length}`);
    totalChildrenFetched += unknownChildren.length;

    // For each unknown child, fetch content and see if it claims an invalid slot
    let repairedThisBitmap = 0;
    for (const childId of unknownChildren) {
      totalChecked++;
      const info = await fetchInscriptionInfo(childId);
      if (!info || !info.content) continue;

      const parsed = parseParcelContent(info.content);
      if (!parsed) continue;
      if (parsed.bitmapNumber !== bm) continue;

      // This child is claiming parcel_number for this bitmap — is that slot invalid?
      const invalidRow = invalidSlots.get(parsed.parcelNumber);
      if (!invalidRow) continue; // slot is either valid or doesn't exist

      logger.info(
        `  REPAIR slot ${parsed.parcelNumber}.${bm}.bitmap: ` +
          `replacing ${invalidRow.inscription_id.slice(0, 16)}… (invalid, h=${invalidRow.block_height}) ` +
          `with ${childId.slice(0, 16)}… (child, h=${info.block_height})`,
      );

      if (!DRY_RUN) {
        // Delete the invalid row and insert the valid child
        await db.run('DELETE FROM parcels WHERE inscription_id = ?', invalidRow.inscription_id);
        await db.run(
          `INSERT INTO parcels
            (inscription_id, parcel_number, bitmap_number, bitmap_inscription_id, content, block_height, inscription_index, timestamp, current_wallet, transaction_count, is_valid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            childId,
            parsed.parcelNumber,
            bm,
            bitmapRow.inscription_id,
            info.content.trim(),
            info.block_height,
            info.inscription_index,
            Date.now(),
            info.address,
            null, // transaction_count can be fetched later if needed
          ],
        );
      }

      // Remove from invalid slots so we don't double-replace
      invalidSlots.delete(parsed.parcelNumber);
      repairedThisBitmap++;
      totalRepaired++;
    }

    if (repairedThisBitmap > 0) {
      logger.info(`  Repaired ${repairedThisBitmap} slots for bitmap ${bm}`);
    } else {
      logger.info(`  No replaceable slots found for bitmap ${bm}`);
    }
  }

  logger.info(`\n=== DONE ===`);
  logger.info(`Bitmaps checked: ${overlaps.length}`);
  logger.info(`Unknown children inspected: ${totalChildrenFetched}`);
  logger.info(`Slots repaired: ${totalRepaired}`);
  if (DRY_RUN) logger.info('(dry run — no DB changes made)');

  process.exit(0);
};

main().catch((err) => {
  logger.error('Repair script failed', { error: err?.message || String(err) });
  process.exit(1);
});
