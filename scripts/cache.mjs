// Shared download rules for the build scripts.
// - Each remote source is fetched at most once every 24 hours. The age comes
//   from the cached file's modified time. `--force` overrides the limit.
// - Every download goes to a .tmp file first and replaces the cache only once
//   it is complete and valid, so a failed or partial download never breaks it.
import { stat, writeFile, rename, readFile, unlink } from 'node:fs/promises';

export const DAY = 24 * 3600 * 1000;
export const force = process.argv.includes('--force');
export const UA = 'tarkov-keys-tool/0.2 (personal fan project)';

export async function ageMs(file) {
  try { return Date.now() - (await stat(file)).mtimeMs; } catch { return Infinity; }
}
export const fmtAge = ms => (ms === Infinity ? 'never' : `${(ms / 3600000).toFixed(1)}h ago`);

// True when `file` is older than 24h (or missing), or --force was given.
export async function due(file) {
  return force || (await ageMs(file)) >= DAY;
}

export async function saveAtomic(dest, data) {
  const tmp = new URL(dest.href + '.tmp');
  try {
    await writeFile(tmp, data);
    await rename(tmp, dest);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Download JSON and only replace the cache if it parses.
export async function downloadJson(url, dest) {
  const buf = await fetchBuffer(url);
  JSON.parse(buf.toString('utf8'));
  await saveAtomic(dest, buf);
}

// A real WebP starts with "RIFF....WEBP".
export const isWebp = buf => buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
export async function validWebp(file) {
  try { return isWebp(await readFile(file)); } catch { return false; }
}
