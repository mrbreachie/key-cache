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
  { id: 'the-labyrinth', name: 'The Labyrinth', svg: null },
  { id: 'icebreaker', name: 'Icebreaker', svg: null },
];
// Maps with keys but no map image at all: keys are listed, doors are not pinned.
const NO_SVG = {};
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

// tarkov.dev's tile maps (Leaflet, CRS.Simple): a game position (x, z) is
// rotated by coordinateRotation, then pixel = 2^zoom * (t0*rx + t1, -t2*ry + t3)
// with transform [t0, t1, t2, t3]. "P0" below is that pixel space at zoom 0.
// Tiles are tileSize squares of it, so tile (tx, ty) at zoom z covers
// P0 [tx, tx + 1) * tileSize / 2^z. The map rectangle is the config's bounds.
function tileSpace(cfg) {
  const [t0, t1, t2, t3] = cfg.transform;
  const r = ((cfg.coordinateRotation || 0) * Math.PI) / 180;
  const p0 = (x, z) => {
    const rx = x * Math.cos(r) - z * Math.sin(r), ry = x * Math.sin(r) + z * Math.cos(r);
    return [t0 * rx + t1, -t2 * ry + t3];
  };
  const [a, b] = cfg.bounds.map(([x, z]) => p0(x, z));
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const u = 1000 / Math.max(x1 - x0, y1 - y0); // page units per P0 unit: the long side is 1000
  return {
    frac: (x, z) => { const [px, py] = p0(x, z); return [(px - x0) / (x1 - x0), (py - y0) / (y1 - y0)]; },
    w: (x1 - x0) * u, h: (y1 - y0) * u,
    tiles: { size: cfg.tileSize || 256, min: cfg.minZoom, max: cfg.maxZoom, x0, y0, u },
  };
}
const usesTiles = id => !!cfgOf[id]?.tilePath;

// tarkov.dev draws The Lab from tiles, so nobody publishes bounds for
// Labs.svg, and projecting with the tile bounds puts pins in the wrong place.
// This correction was fitted (least squares, 2026-11-17) by matching 10 API
// doors to the locked-door marks (#f30000) in Labs.svg's Doors groups.
// The matched doors land within about 5 units of the 720 x 586 viewBox.
// Refit it if Labs.svg is ever replaced.
//
// Customs: with tarkov.dev's 0.16 bounds the pins land about 1.5 units north
// of where Customs.svg draws the doors. Fitted 2026-11-17 by sliding the 30
// doors that open a drawn locked room (the *-locked groups, matched per floor)
// onto those rooms' walls: shift 0.15 units east and 1.5 south (viewBox
// 1062.48 x 535.17). The mean door-to-wall gap fell from 0.72 to 0.44 units.
const CALIBRATE = {
  'the-lab': { ax: 1.32524, bx: -0.175573, ay: 1.063164, by: 0.014455 },
  customs: { ax: 1, bx: 0.15 / 1062.4827, ay: 1, by: 1.5 / 535.17401 },
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

// Where a game position lands on a map, as fractions of the map image (0..1).
// A map can have tiles (satellite style) and a drawing (SVG, drawn style).
// x, y place a point on the tiles when the map has them, else on the drawing;
// sx, sy place it on the drawing when the map has both.
const hasSvg = mid => !!MAPS.find(m => m.id === mid)?.svg;
function svgFrac(mid, x, z) {
  let [fx, fy] = projector(cfgOf[mid])(x, z);
  const cal = CALIBRATE[mid]; // SVG-only corrections
  if (cal) { fx = cal.ax * fx + cal.bx; fy = cal.ay * fy + cal.by; }
  return [fx, fy];
}
function place(mid, pos) {
  const cfg = cfgOf[mid], r4 = v => +v.toFixed(4);
  const out = {};
  if (usesTiles(mid)) {
    // tiles are placed with tarkov.dev's own projection, so no correction is needed
    const [fx, fy] = tileSpace(cfg).frac(pos.x, pos.z);
    out.x = r4(fx); out.y = r4(fy);
    if (hasSvg(mid)) { const [sx, sy] = svgFrac(mid, pos.x, pos.z); out.sx = r4(sx); out.sy = r4(sy); }
  } else {
    const [fx, fy] = svgFrac(mid, pos.x, pos.z);
    out.x = r4(fx); out.y = r4(fy);
  }
  out.floor = floorName(cfg, pos);
  return out;
}
// For a map with both: drawing fraction = a * tile fraction + b on each axis
// (both projections are axis-aligned and linear in game x, z).
function tileToSvg(mid) {
  const cfg = cfgOf[mid], t = tileSpace(cfg);
  const [[x1, z1], [x2, z2]] = cfg.bounds;
  const [t1x, t1y] = t.frac(x1, z1), [t2x, t2y] = t.frac(x2, z2);
  const [s1x, s1y] = svgFrac(mid, x1, z1), [s2x, s2y] = svgFrac(mid, x2, z2);
  const ax = (s2x - s1x) / (t2x - t1x), ay = (s2y - s1y) / (t2y - t1y);
  return { ax, bx: s1x - ax * t1x, ay, by: s1y - ay * t1y };
}

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
    doors.push({
      id: l.id, map: mid, key: l.key,
      ...place(mid, l.position),
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

// Fixed key spawns: tarkov.dev's loose-loot spots that can hold a key. Big
// random-loot pools (65-90 possible items) aren't a key's spawn, so a spot
// counts when it lists at most SPAWN_MAX items and at least one is a key.
// `n` is how many items the spot can hold (1 = only ever this key).
const SPAWN_MAX = 10;
const keySet = new Set(keys.map(k => k.id));
const spawns = [], seenSpawn = new Set();
for (const am of apiMaps) {
  const mid = mapOf[am.normalizedName];
  if (!mid) continue;
  for (const l of am.lootLoose || []) {
    const it = l.items || [];
    if (!it.length || it.length > SPAWN_MAX) continue;
    const ks = it.filter(i => keySet.has(i));
    if (!ks.length) continue;
    const sig = [mid, Math.round(l.position.x), Math.round(l.position.y), Math.round(l.position.z), ks.sort().join(',')].join('|');
    if (seenSpawn.has(sig)) continue;
    seenSpawn.add(sig);
    spawns.push({ map: mid, keys: ks, n: it.length, ...place(mid, l.position) });
  }
}

// Floors: the floor picker's entries, bottom to top. `svg` is the layer
// group id inside the map SVG (empty when the SVG draws no separate floor).
// On Labs every level is a full floor plan, so the picker swaps levels
// instead of overlaying them on the ground level.
const LEVEL_SWAP = {
  'the-lab': { base: 'First_Level', baseName: 'Main Level', layers: { 'Second Level': 'Second_Level', Technical: 'Technical_Level' } },
};
const BELOW = /under|garage|tunnel|basement|bunker|technical/i;
// Floors of a tile map: the main tiles are the base, each config layer with its
// own tiles is drawn on top. A layer without tiles can still use the map's SVG
// floor group (Interchange's and Shoreline's upper floors).
const BASE_NAME = { 'the-lab': 'Main Level' };
function floorsForTiles(id, svg) {
  const cfg = cfgOf[id];
  const has = g => g && svg && svg.includes(`id="${g}"`);
  const layers = cfg.layers || [];
  // Icebreaker lists its main deck again as a layer: use that layer's name for the base.
  const same = layers.find(l => l.tilePath === cfg.tilePath);
  const swap = LEVEL_SWAP[id];
  const baseSvg = swap ? swap.base : cfg.svgLayer;
  const list = [{ name: same ? same.name : BASE_NAME[id] || 'Ground', tiles: cfg.tilePath, svg: has(baseSvg) ? baseSvg : '', base: true }];
  for (const l of layers) {
    if (l === same) continue;
    const g = swap ? swap.layers[l.name] : l.svgLayer;
    list.push({ name: l.name, tiles: l.tilePath || '', svg: has(g) ? g : '' });
  }
  // Icebreaker's deck tiles are numbered bottom to top (00_control_room ... 15_bridge_roof).
  const deck = f => +((f.tiles.match(/\/(\d\d)_/) || [])[1] ?? NaN);
  if (list.every(f => !isNaN(deck(f)))) return list.sort((a, b) => deck(a) - deck(b));
  const below = list.filter(f => BELOW.test(f.name));
  const rest = list.filter(f => !BELOW.test(f.name));
  return [...below, ...rest];
}
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
  const cfg = cfgOf[m.id];
  m.author = cfg?.author || ''; m.authorLink = cfg?.authorLink || '';
  m.doors = doors.filter(d => d.map === m.id && !d.nopin).length;
  const svg = m.svg ? await readFile(p(`data/svg/${m.svg}`), 'utf8') : '';
  // the page sizes the map from tiles.w/h (satellite) or sw/sh (drawn)
  if (svg) {
    const vb = svg.slice(0, 2000).match(/viewBox="([^"]+)"/)[1].split(/[\s,]+/).map(Number);
    m.sw = vb[2]; m.sh = vb[3];
  }
  if (usesTiles(m.id)) {
    const t = tileSpace(cfg);
    m.tiles = { ...t.tiles, w: t.w, h: t.h };
    m.floors = floorsForTiles(m.id, svg);
    m.exclusive = m.id === 'the-lab'; // every Labs level is a full floor plan
    if (svg) m.t2s = tileToSvg(m.id);
  } else {
    m.floors = floorsFor(m.id, svg);
    m.exclusive = !!LEVEL_SWAP[m.id];
  }
  delete m.also;
  if (!m.svg) continue;
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
  spawns,
};
await writeFile(p('assets/data.js'), 'window.TK_DATA = ' + JSON.stringify(out) + ';\n');
const pinned = out.doors.length;
const noWiki = keys.filter(k => !k.behindLock && k.maps.length).map(k => k.name);
console.log(`${keys.length} keys, ${pinned} doors pinned, ${spawns.length} fixed key spawns for ${new Set(spawns.flatMap(s => s.keys)).size} keys, ${got} icons`);
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
