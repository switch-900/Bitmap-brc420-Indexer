/**
 * One-time parcel validation / cleanup script.
 *
 * Applies the reference Bitmap Parcel spec rules to every row in the `parcels`
 * table and sets `is_valid = 0` for any row that fails:
 *
 *   1. Format:  {parcelNumber}.{bitmapNumber}.bitmap   (already enforced at insert)
 *   2. parcel_number >= 0                               (already enforced at insert)
 *   3. parcel_number < block txCount   (for bitmapNumber != 0)
 *   4. parcel genesis_height >= parent bitmap genesis_height
 *   5. Parent bitmap must exist in `bitmaps` table
 *   6. First-is-first dedup   (already enforced by UNIQUE index + upsert)
 *   7. Provenance: parcel inscription must be a child of the bitmap inscription
 *
 * Usage:
 *   cd server && npx ts-node src/tools/validateParcels.ts
 *
 * Pass --dry-run to preview without writing to DB.
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
  is_valid: number;
}

interface BitmapRow {
  bitmap_number: number;
  inscription_id: string;
  block_height: number;
}

const fetchTxCount = async (blockHeight: number): Promise<number | null> => {
  try {
    const res = await axios.get(`${ORD_API_URL}/r/blockinfo/${blockHeight}`, {
      headers: { Accept: 'application/json,*/*' },
      timeout: 10000,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const txCount = (res.data as any)?.transaction_count;
    if (typeof txCount === 'number' && Number.isFinite(txCount) && txCount >= 0) return txCount;
  } catch (err: any) {
    logger.warn('Failed to fetch txCount', { blockHeight, message: err?.message });
  }
  return null;
};

/** Fetch all children inscription IDs for a parent inscription via /r/children pagination. */
const fetchChildrenSet = async (parentInscriptionId: string): Promise<Set<string>> => {
  const ids: string[] = [];
  let page = 0;
  while (true) {
    const url = page === 0
      ? `${ORD_API_URL}/r/children/${parentInscriptionId}`
      : `${ORD_API_URL}/r/children/${parentInscriptionId}/${page}`;
    const res = await axios.get(url, {
      headers: { Accept: 'application/json,*/*' },
      timeout: 15000,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const pageIds: string[] = Array.isArray((res.data as any)?.ids) ? (res.data as any).ids : [];
    ids.push(...pageIds.map((s) => String(s).toLowerCase()));
    const more = !!(res.data as any)?.more;
    if (!more || pageIds.length === 0) break;
    page++;
    if (page > 2000) throw new Error('children pagination runaway');
  }
  return new Set(ids);
};

const main = async () => {
  if (DRY_RUN) logger.info('DRY RUN — no DB writes');

  await setupDatabase();
  const db = getDb;
  if (!db) throw new Error('Database not initialized');

  // Load all parcels
  const parcels = await db.all<ParcelRow[]>(
    'SELECT inscription_id, parcel_number, bitmap_number, block_height, is_valid FROM parcels ORDER BY bitmap_number, parcel_number'
  );
  logger.info(`Loaded ${parcels.length} parcels across DB`);

  // Load all bitmaps (bitmap_number → { inscription_id, block_height })
  const bitmapRows = await db.all<BitmapRow[]>('SELECT bitmap_number, inscription_id, block_height FROM bitmaps');
  const bitmapMap = new Map<number, { inscription_id: string; block_height: number }>();
  for (const b of bitmapRows) {
    bitmapMap.set(b.bitmap_number, { inscription_id: b.inscription_id, block_height: b.block_height });
  }
  logger.info(`Loaded ${bitmapRows.length} bitmaps for genesis-height + provenance lookup`);

  // Group parcels by bitmap_number so we only fetch txCount once per bitmap
  const byBitmap = new Map<number, ParcelRow[]>();
  for (const p of parcels) {
    let arr = byBitmap.get(p.bitmap_number);
    if (!arr) { arr = []; byBitmap.set(p.bitmap_number, arr); }
    arr.push(p);
  }

  const txCountCache = new Map<number, number | null>();
  let invalidated = 0;
  let alreadyInvalid = 0;
  let valid = 0;

  const invalidIds: string[] = [];

  const bitmapNumbers = [...byBitmap.keys()].sort((a, b) => a - b);
  for (let bi = 0; bi < bitmapNumbers.length; bi++) {
    const bm = bitmapNumbers[bi];
    const rows = byBitmap.get(bm)!;
    const bitmapInfo = bitmapMap.get(bm) ?? null;
    const bitmapGenesisHeight = bitmapInfo?.block_height ?? null;
    const bitmapInscriptionId = bitmapInfo?.inscription_id ?? null;

    // Fetch txCount (skip for bitmap 0 per spec)
    let txCount: number | null = null;
    if (bm !== 0) {
      if (txCountCache.has(bm)) {
        txCount = txCountCache.get(bm)!;
      } else {
        txCount = await fetchTxCount(bm);
        txCountCache.set(bm, txCount);
      }
    }

    // Fetch children set for provenance check (only if bitmap exists)
    let childrenSet: Set<string> | null = null;
    if (bitmapInscriptionId) {
      try {
        childrenSet = await fetchChildrenSet(bitmapInscriptionId);
      } catch (err: any) {
        logger.warn(`Failed to fetch children for bitmap ${bm} (${bitmapInscriptionId}): ${err?.message}`);
      }
    }

    for (const p of rows) {
      let reason: string | null = null;

      // Rule 5: parent bitmap must exist
      if (bitmapGenesisHeight === null) {
        reason = `orphan: bitmap ${bm} not in bitmaps table`;
      }
      // Rule 4: parcel inscribed before parent bitmap
      else if (p.block_height < bitmapGenesisHeight) {
        reason = `too early: parcel height ${p.block_height} < bitmap height ${bitmapGenesisHeight}`;
      }
      // Rule 3: parcel_number < txCount (bitmap 0 exempt)
      else if (bm !== 0 && txCount !== null && p.parcel_number >= txCount) {
        reason = `parcel_number ${p.parcel_number} >= txCount ${txCount}`;
      }
      // Rule 7: provenance — must be child of bitmap inscription
      else if (childrenSet && !childrenSet.has(p.inscription_id.toLowerCase())) {
        reason = `not a child of bitmap ${bm} (${bitmapInscriptionId})`;
      }

      if (reason) {
        if (p.is_valid === 0) {
          alreadyInvalid++;
        } else {
          invalidated++;
          invalidIds.push(p.inscription_id);
          if (invalidated <= 30) {
            logger.info(`INVALIDATE ${p.inscription_id} (${p.parcel_number}.${bm}.bitmap): ${reason}`);
          }
        }
      } else {
        valid++;
      }
    }

    if ((bi + 1) % 100 === 0) {
      logger.info(`Progress: ${bi + 1}/${bitmapNumbers.length} bitmaps checked`);
    }
  }

  logger.info(`\nResults: valid=${valid} invalidated=${invalidated} already_invalid=${alreadyInvalid} total=${parcels.length}`);

  if (invalidIds.length > 0 && !DRY_RUN) {
    // Batch update in chunks of 500
    const BATCH = 500;
    for (let i = 0; i < invalidIds.length; i += BATCH) {
      const batch = invalidIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      await db.run(
        `UPDATE parcels SET is_valid = 0 WHERE inscription_id IN (${placeholders})`,
        batch
      );
    }
    logger.info(`Marked ${invalidIds.length} parcels as is_valid = 0`);

    // Report final counts
    const finalCounts = await db.get<{ valid: number; invalid: number }>(
      'SELECT SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid, SUM(CASE WHEN is_valid = 0 THEN 1 ELSE 0 END) as invalid FROM parcels'
    );
    logger.info(`Final DB state: valid=${finalCounts?.valid} invalid=${finalCounts?.invalid}`);
  } else if (invalidIds.length > 0) {
    logger.info(`DRY RUN: would invalidate ${invalidIds.length} parcels`);
  } else {
    logger.info('No changes needed — all parcels are valid');
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
