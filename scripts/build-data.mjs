// Joins tarkov.dev map/item data with the wiki key pages into assets/data.js,
// downloads key icons into data/icons/ and writes the map scripts into assets/maps/.
// Usage: node scripts/build-data.mjs [--refresh] [--force]
//   --refresh  re-download maps and items from json.tarkov.dev, but only if
//              the cached copies are more than 24 hours old
//   --force    ignore the 24-hour limit (for the API and for icon retries)
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { ageMs, fmtAge, due, force, downloadJson, fetchBuffer, saveAtomic, isWebp, validWebp, DAY } from './cache.mjs';

const root = new URL('../', import.meta.url);
const p = rel => new URL(rel, root);
const exists = f => access(f).then(() => true, () => false);

const API_FILES = [
  ['https://json.tarkov.dev/regular/maps', p('data/api-maps.json')],
  ['https://json.tarkov.dev/regular/items?lang=en', p('data/api-items.json')],
];
const apiAge = Math.max(...(await Promise.all(API_FILES.map(([, f]) => ageMs(f)))));
const missing = apiAge === Infinity;
if (missing || (process.argv.includes('--refresh') && (await Promise.all(API_FILES.map(([, f]) => due(f)))).some(Boolean))) {
  console.log('downloading maps and items from json.tarkov.dev');
  for (const [url, dest] of API_FILES) await downloadJson(url, dest);
} else if (process.argv.includes('--refresh')) {
  console.log(`API data was fetched ${fmtAge(apiAge)}; it is fetched at most once every 24h. Using the cache (add --force to override).`);
} else {
  console.log(`using cached API data from ${fmtAge(apiAge)}`);
}

const read = async f => JSON.parse(await readFile(p(f), 'utf8'));
const apiMaps = Object.values((await read('data/api-maps.json')).data.maps);
const items = (await read('data/api-items.json')).data.items;
const wiki = await read('data/wiki-keys.json');
const config = await read('data/maps-config.json');

// Maps we have an SVG for. API map ids that share a layout point at one entry.
const MAPS = [
  { id: 'customs', name: 'Customs', svg: 'Customs.svg' },
  { id: 'factory', name: 'Factory', svg: 'Factory.svg', also: ['night-factory'] },
  { id: 'interchange', name: 'Interchange', svg: 'Interchange.svg' },
  { id: 'the-lab', name: 'The Lab', svg: 'Labs.svg' },
  { id: 'lighthouse', name: 'Lighthouse', svg: 'Lighthouse.svg' },
  { id: 'reserve', name: 'Reserve', svg: 'Reserve.svg' },
  { id: 'shoreline', name: 'Shoreline', svg: 'Shoreline.svg' },
  { id: 'streets-of-tarkov', name: 'Streets of Tarkov', svg: 'StreetsOfTarkov.svg' },
  { id: 'woods', name: 'Woods', svg: 'Woods.svg' },
  { id: 'ground-zero', name: 'Ground Zero', svg: 'GroundZero.svg', also: ['ground-zero-21'] },
  { id: 'terminal', name: 'Terminal', svg: 'Terminal.svg' },
];
// Maps with keys but no SVG yet: keys are listed, doors are not pinned.
const NO_SVG = { 'the-labyrinth': 'The Labyrinth', icebreaker: 'Icebreaker' };
const mapOf = {};
MAPS.forEach(m => [m.id, ...(m.also || [])].forEach(a => (mapOf[a] = m.id)));

// Same projection tarkov.dev uses: rotate (x, z), scale, flip y, then place
// inside the SVG's bounds rectangle.
function projector(cfg) {
  const s = cfg.transform[0];
  const r = ((cfg.coordinateRotation || 0) * Math.PI) / 180;
  const proj = (x, z) => [s * (x * Math.cos(r) - z * Math.sin(r)), -s * (x * Math.sin(r) + z * Math.cos(r))];
  // tarkov.dev stretches the SVG over svgBounds when a map has them (Reserve),
  // and over bounds otherwise.
  const [a, b] = (cfg.svgBounds || cfg.bounds).map(([x, z]) => proj(x, z));
  const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
  return (x, z) => {
    const [px, py] = proj(x, z);
    return [(px - minX) / (maxX - minX), (py - minY) / (maxY - minY)];
  };
}

// tarkov.dev draws The Lab from tiles, so nobody publishes bounds for
// Labs.svg, and projecting with the tile bounds puts pins in the wrong place.
// This correction was fitted (least squares, 2026-11-17) by matching 10 API
// doors to the locked-door marks (#f30000) in Labs.svg's Doors groups.
// The matched doors land within about 5 units of the 720 x 586 viewBox.
// Refit it if Labs.svg is ever replaced.
const CALIBRATE = {
  'the-lab': { ax: 1.32524, bx: -0.175573, ay: 1.063164, by: 0.014455 },
};

function floorName(cfg, pos) {
  for (const layer of cfg.layers || []) {
    for (const ext of layer.extents || []) {
      const [lo, hi] = ext.height;
      if (pos.y < lo || pos.y >= hi) continue;
      if (!ext.bounds) return layer.name;
      for (const [c1, c2] of ext.bounds) {
        const inX = pos.x >= Math.min(c1[0], c2[0]) && pos.x <= Math.max(c1[0], c2[0]);
        const inZ = pos.z >= Math.min(c1[1], c2[1]) && pos.z <= Math.max(c1[1], c2[1]);
        if (inX && inZ) return layer.name;
      }
    }
  }
  return '';
}

const cfgOf = {};
for (const g of config) {
  const m = g.maps.find(m => m.projection === 'interactive' && m.bounds);
  if (m) cfgOf[g.normalizedName] = m;
}

const wikiByUrl = {};
const norm = u => decodeURIComponent(u || '').toLowerCase().replace(/_/g, ' ');
wiki.forEach(w => (wikiByUrl[norm(w.wiki)] = w));

const titleCase = s => s.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());

// Doors
const doors = [];
const seen = new Set();
const keyIds = new Set();
for (const am of apiMaps) {
  const mid = mapOf[am.normalizedName];
  for (const l of am.locks || []) {
    if (!l.key) continue;
    keyIds.add(l.key);
    if (!mid) { doors.push({ map: am.normalizedName, key: l.key, nopin: true }); continue; }
    const sig = [mid, l.key, Math.round(l.position.x), Math.round(l.position.z)].join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const cfg = cfgOf[mid];
    let [fx, fy] = projector(cfg)(l.position.x, l.position.z);
    const cal = CALIBRATE[mid];
    if (cal) { fx = cal.ax * fx + cal.bx; fy = cal.ay * fy + cal.by; }
    doors.push({
      id: l.id, map: mid, key: l.key,
      x: +fx.toFixed(4), y: +fy.toFixed(4),
      floor: floorName(cfg, l.position),
      type: l.lockType, power: !!l.needsPower,
    });
  }
}

// Where tarkov.dev places a key outside of locks: as the item an extract asks
// for (transferItem) or as loose loot. Only used for keys that have no door
// and no map on the wiki (e.g. The Labyrinth's Ariadne key, gas torch, valve).
const keyUse = {}, keyLoose = {};
for (const am of apiMaps) {
  const mid = mapOf[am.normalizedName] || am.normalizedName;
  for (const e of am.extracts || []) if (e.transferItem?.item) (keyUse[e.transferItem.item] ||= new Set()).add(mid);
  for (const l of am.lootLoose || []) for (const id of l.items || []) (keyLoose[id] ||= new Set()).add(mid);
}

// Keys: every key item, plus keycards that open a door.
const keys = [];
for (const it of Object.values(items)) {
  const isKey = (it.types || []).includes('keys') || keyIds.has(it.id);
  if (!isKey) continue;
  const w = wikiByUrl[norm(it.wikiLink)];
  const doorMaps = [...new Set(doors.filter(d => d.key === it.id).map(d => d.map))];
  let maps = doorMaps;
  if (!maps.length && w?.map) {
    const m = MAPS.find(m => m.name === w.map);
    if (m) maps = [m.id];
  }
  let useNote = '', foundNote = '';
  // Skipped when the wiki already says the key opens nothing ("does not open any lock").
  if (!maps.length && !w?.usage && !w?.lockLocation) {
    const nm = id => MAPS.find(m => m.id === id)?.name || NO_SVG[id] || id;
    const used = [...(keyUse[it.id] || [])], loose = [...(keyLoose[it.id] || [])];
    maps = [...new Set([...used, ...loose])];
    if (used.length) useNote = `Needed for an extract on ${used.map(nm).join(', ')} (tarkov.dev).`;
    if (loose.length) foundNote = `* Loose loot on ${loose.map(nm).join(', ')} (tarkov.dev)`;
  }
  // Wiki pages saved before fetch-wiki dropped category tags and other-language
  // links still contain lines like "Category:Keys" or "fr:Clé ...": drop them here too.
  const tidy = t => (t || '').split('\n').filter(l => !/^(Category|[a-z]{2,3}(-[a-z]+)?):\S/.test(l.trim())).join('\n').trim();
  keys.push({
    id: it.id,
    name: w?.title || titleCase(it.normalizedName),
    wiki: w?.wiki || it.wikiLink || '',
    link: it.link,
    price: it.avg24hPrice || it.lastLowPrice || 0,
    trader: Math.max(0, ...(it.sellFor || []).map(s => s.price || 0)),
    maps,
    usage: tidy(w?.usage) || useNote,
    keyLocation: tidy(w?.keyLocation) || foundNote,
    lockLocation: tidy(w?.lockLocation),
    behindLock: tidy(w?.behindLock),
    quests: tidy(w?.quests),
  });
}
keys.sort((a, b) => a.name.localeCompare(b.name));

// Floors: the floor picker's entries, bottom to top. `svg` is the layer
// group id inside the map SVG (empty when the SVG draws no separate floor).
// On Labs every level is a full floor plan, so the picker swaps levels
// instead of overlaying them on the ground level.
const LEVEL_SWAP = {
  'the-lab': { base: 'First_Level', baseName: 'Main Level', layers: { 'Second Level': 'Second_Level', Technical: 'Technical_Level' } },
};
const BELOW = /under|garage|tunnel|basement|bunker|technical/i;
function floorsFor(id, svg) {
  const cfg = cfgOf[id] || {};
  const swap = LEVEL_SWAP[id];
  const has = g => g && svg.includes(`id="${g}"`);
  const base = swap ? swap.base : cfg.svgLayer;
  const list = [{ name: swap ? swap.baseName : 'Ground', svg: base, base: true }];
  for (const l of cfg.layers || []) {
    const g = swap ? swap.layers[l.name] : l.svgLayer;
    list.push({ name: l.name, svg: has(g) ? g : '' });
  }
  const below = list.filter(f => BELOW.test(f.name));
  const rest = list.filter(f => !BELOW.test(f.name));
  return [...below, ...rest];
}
// The map SVG goes inline in the page, so scope its <style> rules to the
// map and drop the fixed size (the page sizes it).
function scopeSvg(svg) {
  return svg
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/, (_, a, css) =>
      `<style${a}>` + css.replace(/(^|\})\s*([^{}@]+)\{/g, (m, end, sel) =>
        end + '\n.mapsvg ' + sel.trim().split(/\s*,\s*/).join(', .mapsvg ') + ' {') + '</style>')
    .replace(/<svg\b([^>]*)>/, (m, attrs) =>
      '<svg' + attrs.replace(/\s(width|height)="[^"]*"/g, '').replace(/\sclass="[^"]*"/, '') + ' class="mapsvg">');
}

// Assets
await mkdir(p('assets/maps/'), { recursive: true });
await mkdir(p('data/icons/'), { recursive: true });
await mkdir(p('data/preview/'), { recursive: true });
for (const m of MAPS) {
  const svg = await readFile(p(`data/svg/${m.svg}`), 'utf8');
  const vb = svg.slice(0, 2000).match(/viewBox="([^"]+)"/)[1].split(/[\s,]+/).map(Number);
  m.w = vb[2]; m.h = vb[3];
  m.doors = doors.filter(d => d.map === m.id && !d.nopin).length;
  m.floors = floorsFor(m.id, svg);
  m.exclusive = !!LEVEL_SWAP[m.id];
  const scoped = scopeSvg(svg);
  await writeFile(p(`data/preview/${m.svg}`), scoped);
  // The page loads maps as <script> files (maps/Name.js), the same way it loads
  // data.js: fetch() of the .svg didn't work on the hosted page.
  await writeFile(p(`assets/maps/${m.svg.replace(/\.svg$/, '.js')}`),
    `window.TK_MAP && window.TK_MAP(${JSON.stringify(m.svg)}, ${JSON.stringify(scoped)});\n`);
  delete m.also;
}
// Icons: downloaded once and kept in data/icons/. A cached icon is only
// fetched again if the file is damaged (not a valid WebP). An icon that
// failed is noted in data/icon-misses.json and not retried for 24h.
const MISSES = p('data/icon-misses.json');
let misses = {};
try { misses = JSON.parse(await readFile(MISSES, 'utf8')); } catch {}
let got = 0, fetched = 0, skipped = 0;
for (const k of keys) {
  const dest = p(`data/icons/${k.id}.webp`);
  if (await validWebp(dest)) { got++; delete misses[k.id]; continue; }
  if (!force && misses[k.id] && Date.now() - misses[k.id] < DAY) { skipped++; continue; }
  try {
    const buf = await fetchBuffer(`https://assets.tarkov.dev/${k.id}-icon.webp`);
    if (!isWebp(buf)) throw new Error('not a WebP');
    await saveAtomic(dest, buf);
    got++; fetched++; delete misses[k.id];
  } catch { misses[k.id] = Date.now(); }
}
await writeFile(MISSES, JSON.stringify(misses, null, 1));
console.log(`icons: ${got} cached, ${fetched} downloaded now, ${Object.keys(misses).length} unavailable${skipped ? ` (${skipped} not retried until 24h pass)` : ''}`);
for (const k of keys) k.icon = await validWebp(p(`data/icons/${k.id}.webp`));

const out = {
  built: new Date().toISOString().slice(0, 10),
  maps: MAPS,
  extraMaps: NO_SVG,
  keys,
  doors: doors.filter(d => !d.nopin),
};
await writeFile(p('assets/data.js'), 'window.TK_DATA = ' + JSON.stringify(out) + ';\n');
const pinned = out.doors.length;
const noWiki = keys.filter(k => !k.behindLock && k.maps.length).map(k => k.name);
console.log(`${keys.length} keys, ${pinned} doors pinned, ${got} icons`);
console.log('per map:', MAPS.map(m => `${m.name} ${m.doors}`).join(', '));
console.log(`keys on a map with no loot text (${noWiki.length}):`, noWiki.join('; '));

// Pack icons into one script (a publish takes at most 255 files).
const icons = {};
for (const k of keys) {
  if (!k.icon) continue;
  icons[k.id] = 'data:image/webp;base64,' + (await readFile(p(`data/icons/${k.id}.webp`))).toString('base64');
}
await writeFile(p('assets/icons.js'), 'window.TK_ICONS = ' + JSON.stringify(icons) + ';\n');
console.log(`icons.js: ${Object.keys(icons).length} icons`);
