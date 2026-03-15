import 'dotenv/config';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import axios from 'axios';

import { setupDatabase, db as getDb } from '../db/database';
import logger from '../utils/logger';

type BitmapRow = {
  bitmap_number: number;
  inscription_id: string;
};

type ParcelRow = {
  parcel_number: number;
  bitmap_number: number;
  inscription_id: string;
};

type ExportState = {
  lastMaxBitmap: number;
  lastExportedAt: number;
  chunkSize: number;
  subdir: string;
};

const lastMaxBitmapTextFile = (stateFile: string): string => {
  return path.join(path.dirname(stateFile), 'last_max_bitmap.txt');
};

const writeLastMaxBitmapText = (stateFile: string, maxBitmap: number) => {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const maxPath = lastMaxBitmapTextFile(stateFile);
    const tmpMax = `${maxPath}.tmp`;
    fs.writeFileSync(tmpMax, `${Math.floor(maxBitmap)}\n`);
    fs.renameSync(tmpMax, maxPath);
  } catch {
    // non-fatal
  }
};

const ORD_API_URL = process.env.API_URL || 'http://127.0.0.1:4000';

const parseIntEnv = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const defaultStateFile = (): string => {
  const xdgStateHome = String(process.env.XDG_STATE_HOME || '').trim();
  const base = xdgStateHome || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'bitmap-data-updater', 'state.json');
};

const readState = (stateFile: string): ExportState | null => {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);

    const lastMaxBitmap = Number(parsed?.lastMaxBitmap);
    const lastExportedAt = Number(parsed?.lastExportedAt);
    const chunkSize = Number(parsed?.chunkSize);
    const subdir = String(parsed?.subdir ?? '');

    if (!Number.isFinite(lastMaxBitmap) || lastMaxBitmap < 0) return null;
    if (!Number.isFinite(lastExportedAt) || lastExportedAt <= 0) return null;
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) return null;
    if (!subdir) return null;

    return { lastMaxBitmap, lastExportedAt, chunkSize, subdir };
  } catch {
    return null;
  }
};

const writeState = (stateFile: string, state: ExportState) => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmpPath = `${stateFile}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state) + '\n');
  fs.renameSync(tmpPath, stateFile);

  // Also write a tiny text file so systemd gating can avoid parsing JSON.
  const maxPath = lastMaxBitmapTextFile(stateFile);
  const tmpMax = `${maxPath}.tmp`;
  fs.writeFileSync(tmpMax, `${Math.floor(state.lastMaxBitmap)}\n`);
  fs.renameSync(tmpMax, maxPath);
};

const runGit = (repoDir: string, args: string[]): string => {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
};

const ensureRepo = (repoDir: string, repoUrl: string | undefined) => {
  if (fs.existsSync(path.join(repoDir, '.git'))) return;
  if (!repoUrl) {
    throw new Error(
      `BITMAP_DATA_REPO_DIR (${repoDir}) is not a git repo. Set BITMAP_DATA_REPO_URL to auto-clone, or clone it manually.`
    );
  }
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  execFileSync('git', ['clone', repoUrl, repoDir], { stdio: 'inherit' });
};

const chunkFileName = (start: number, chunkSize: number): string => {
  const endInclusive = start + chunkSize - 1;
  return `${start}-${endInclusive}.json`;
};

const usage = () => {
  // eslint-disable-next-line no-console
  console.error('Usage: ts-node src/tools/updateBitmapDataRepo.ts');
  // eslint-disable-next-line no-console
  console.error('Env:');
  // eslint-disable-next-line no-console
  console.error('  BITMAP_DATA_REPO_DIR   (required) path to local clone of the GitHub data repo');
  // eslint-disable-next-line no-console
  console.error('  BITMAP_DATA_REPO_URL   (optional) clone URL if repo dir does not exist');
  // eslint-disable-next-line no-console
  console.error('  BITMAP_DATA_SUBDIR     (optional) default: bitmaps');
  // eslint-disable-next-line no-console
  console.error('  BITMAP_DATA_CHUNK_SIZE (optional) default: 100000');
  // eslint-disable-next-line no-console
  console.error('  BITMAP_DATA_CHUNKS_TO_UPDATE (optional) default: 2 (last chunk + previous)');
  // eslint-disable-next-line no-console
  console.error('  API_URL (optional) default: http://127.0.0.1:4000 (ord)');
  // eslint-disable-next-line no-console
  console.error('  BITMAP_DATA_STATE_FILE (optional) path to local exporter state (default: ~/.local/state/bitmap-data-updater/state.json)');
  // eslint-disable-next-line no-console
  console.error('  BITMAP_DATA_FORCE_EXPORT_EVERY_MS (optional) default: 3600000 (force refresh even if max bitmap unchanged)');
};

const main = async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const repoDir = String(process.env.BITMAP_DATA_REPO_DIR || '').trim();
  if (!repoDir) {
    usage();
    throw new Error('Missing BITMAP_DATA_REPO_DIR');
  }

  const repoUrl = String(process.env.BITMAP_DATA_REPO_URL || '').trim() || undefined;
  const subdir = String(process.env.BITMAP_DATA_SUBDIR || 'bitmaps').trim() || 'bitmaps';
  const chunkSize = Math.max(1, parseIntEnv(process.env.BITMAP_DATA_CHUNK_SIZE, 100000));
  const chunksToUpdate = Math.max(1, parseIntEnv(process.env.BITMAP_DATA_CHUNKS_TO_UPDATE, 2));
  const exportAll = String(process.env.BITMAP_DATA_EXPORT_ALL || '').toLowerCase() === 'true';
  const stateFile = String(process.env.BITMAP_DATA_STATE_FILE || '').trim() || defaultStateFile();
  const forceEveryMs = Math.max(0, parseIntEnv(process.env.BITMAP_DATA_FORCE_EXPORT_EVERY_MS, 60 * 60 * 1000));

  await setupDatabase();
  const db = getDb;
  if (!db) throw new Error('Database not initialized');

  const maxRow = await db.get<{ max_bitmap: number | null }>('SELECT MAX(bitmap_number) AS max_bitmap FROM bitmaps');
  const maxBitmap = Number(maxRow?.max_bitmap);
  if (!Number.isFinite(maxBitmap) || maxBitmap < 0) {
    logger.info('No bitmaps found in DB; nothing to export');
    return;
  }

  if (!exportAll && forceEveryMs > 0) {
    const prev = readState(stateFile);
    const now = Date.now();
    const recentlyExported = prev && now - prev.lastExportedAt < forceEveryMs;
    const sameShape = prev && prev.chunkSize === chunkSize && prev.subdir === subdir;
    if (prev && sameShape && prev.lastMaxBitmap === maxBitmap && recentlyExported) {
      // Ensure the plain-text max bitmap file exists for systemd gating.
      writeLastMaxBitmapText(stateFile, maxBitmap);
      logger.info('No new max bitmap since last export; skipping', {
        maxBitmap,
        lastExportedAt: prev.lastExportedAt,
        stateFile,
        forceEveryMs,
      });
      return;
    }
  }

  let ordTip: number | null = null;
  try {
    const res = await axios.get(`${ORD_API_URL}/r/blockheight`, {
      timeout: 5000,
      responseType: 'text',
      transformResponse: (d) => d,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const n = Number.parseInt(String(res.data || '').trim(), 10);
    ordTip = Number.isFinite(n) ? n : null;
  } catch {
    // non-fatal
  }

  const lastChunkStart = Math.floor(maxBitmap / chunkSize) * chunkSize;
  const chunkStarts: number[] = [];
  if (exportAll) {
    for (let start = 0; start <= lastChunkStart; start += chunkSize) {
      chunkStarts.push(start);
    }
    logger.info('Exporting ALL bitmap chunks', { chunkSize, chunks: chunkStarts.length, maxBitmap });
  } else {
    for (let i = 0; i < chunksToUpdate; i++) {
      const start = lastChunkStart - i * chunkSize;
      if (start < 0) break;
      chunkStarts.push(start);
    }
    logger.info('Exporting latest bitmap chunks', { chunkSize, chunks: chunkStarts.length, maxBitmap });
  }

  ensureRepo(repoDir, repoUrl);
  try {
    runGit(repoDir, ['pull', '--rebase']);
  } catch {
    // non-fatal; e.g., first run with no remote updates
  }

  const outDir = path.join(repoDir, subdir);
  fs.mkdirSync(outDir, { recursive: true });

  // Write meta.json with heights / timestamp so the front-end can show indicators.
  const metaPath = path.join(outDir, 'meta.json');
  const meta = { maxBitmap, ordTip, updatedAt: new Date().toISOString(), chunkSize };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  const written: string[] = [path.join(subdir, 'meta.json')];
  for (const start of chunkStarts) {
    const endInclusive = start + chunkSize - 1;
    const rows = await db.all<BitmapRow[]>(
      `
        SELECT bitmap_number, inscription_id
        FROM bitmaps
        WHERE bitmap_number BETWEEN ? AND ?
        ORDER BY bitmap_number ASC
      `,
      [start, endInclusive]
    );

    const arr: Array<string | null> = new Array(chunkSize).fill(null);
    for (const r of rows) {
      const n = Number(r.bitmap_number);
      if (!Number.isFinite(n)) continue;
      const idx = n - start;
      if (idx < 0 || idx >= chunkSize) continue;
      const id = String(r.inscription_id || '').trim();
      if (!id) continue;
      arr[idx] = id;
    }

    const filename = chunkFileName(start, chunkSize);
    const outPath = path.join(outDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(arr) + '\n');
    written.push(path.join(subdir, filename));
    logger.info('Wrote bitmap chunk', { file: outPath, start, endInclusive, present: rows.length });
  }

  // ── Parcel export ──────────────────────────────────────────────
  const parcelSubdir = 'parcels';
  const parcelOutDir = path.join(repoDir, parcelSubdir);
  fs.mkdirSync(parcelOutDir, { recursive: true });

  const allParcels = await db.all<ParcelRow[]>(
    `SELECT parcel_number, bitmap_number, inscription_id
     FROM parcels
     WHERE is_valid = 1
     ORDER BY bitmap_number, parcel_number`
  );

  // Group by bitmap_number → array of [parcel_number, inscription_id] tuples
  const parcelsByBitmap = new Map<number, Array<[number, string]>>();
  for (const p of allParcels) {
    const bm = Number(p.bitmap_number);
    if (!Number.isFinite(bm)) continue;
    let arr = parcelsByBitmap.get(bm);
    if (!arr) { arr = []; parcelsByBitmap.set(bm, arr); }
    arr.push([Number(p.parcel_number), String(p.inscription_id || '').trim()]);
  }

  // Determine which chunks contain parcel data
  const parcelChunkStarts = new Set<number>();
  for (const bm of parcelsByBitmap.keys()) {
    parcelChunkStarts.add(Math.floor(bm / chunkSize) * chunkSize);
  }

  // Write parcels meta
  const parcelMetaPath = path.join(parcelOutDir, 'meta.json');
  const parcelMeta = {
    totalParcels: allParcels.length,
    bitmapsWithParcels: parcelsByBitmap.size,
    updatedAt: new Date().toISOString(),
    chunkSize,
  };
  fs.writeFileSync(parcelMetaPath, JSON.stringify(parcelMeta, null, 2) + '\n');
  written.push(path.join(parcelSubdir, 'meta.json'));

  // Write parcel chunk files (object keyed by bitmap_number → [[parcelNum, inscId], ...])
  for (const start of [...parcelChunkStarts].sort((a, b) => a - b)) {
    const endInclusive = start + chunkSize - 1;
    const obj: Record<number, Array<[number, string]>> = {};
    for (const [bm, parcels] of parcelsByBitmap) {
      if (bm >= start && bm <= endInclusive) {
        obj[bm] = parcels;
      }
    }
    const filename = chunkFileName(start, chunkSize);
    const outPath = path.join(parcelOutDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(obj) + '\n');
    written.push(path.join(parcelSubdir, filename));
    logger.info('Wrote parcel chunk', { file: outPath, start, endInclusive, bitmaps: Object.keys(obj).length });
  }

  const status = runGit(repoDir, ['status', '--porcelain', '--', subdir, parcelSubdir]);
  if (!status) {
    logger.info('No changes to commit/push');
    writeState(stateFile, {
      lastMaxBitmap: maxBitmap,
      lastExportedAt: Date.now(),
      chunkSize,
      subdir,
    });
    return;
  }

  runGit(repoDir, ['add', '--', ...written]);

  const msg = `Update bitmap ids (max_bitmap=${maxBitmap}${ordTip !== null ? ` tip=${ordTip}` : ''} parcels=${allParcels.length})`;
  try {
    runGit(repoDir, ['commit', '-m', msg]);
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e);
    throw new Error(`git commit failed. Ensure user.name/user.email are configured. Details: ${stderr}`);
  }

  try {
    runGit(repoDir, ['push']);
  } catch {
    // First push on a brand-new repo/branch may not have an upstream configured.
    runGit(repoDir, ['push', '-u', 'origin', 'HEAD']);
  }
  logger.info('Pushed bitmap data repo updates', { repoDir, msg });

  writeState(stateFile, {
    lastMaxBitmap: maxBitmap,
    lastExportedAt: Date.now(),
    chunkSize,
    subdir,
  });
};

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
