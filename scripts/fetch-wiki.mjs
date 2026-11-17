// Downloads every page in the Tarkov wiki's Category:Keys and Category:Keycards and extracts the
// sections the tool uses. Wiki text is CC BY-NC-SA; the page credits it.
// Usage: node scripts/fetch-wiki.mjs [--force]   -> writes data/wiki-keys.json
// The wiki is fetched at most once every 24 hours; --force overrides that.
import { mkdir } from 'node:fs/promises';
import { ageMs, fmtAge, due, saveAtomic, UA } from './cache.mjs';

const API = 'https://escapefromtarkov.fandom.com/api.php';
const OUT = new URL('../data/wiki-keys.json', import.meta.url);
if (!(await due(OUT))) {
  console.log(`wiki data was fetched ${fmtAge(await ageMs(OUT))}; it is fetched at most once every 24h. Nothing to do (add --force to override).`);
  process.exit(0);
}

async function api(params) {
  const url = API + '?' + new URLSearchParams({ format: 'json', ...params });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

async function categoryTitles(cat) {
  const titles = [];
  let cont = {};
  do {
    const j = await api({ action: 'query', list: 'categorymembers', cmtitle: cat, cmlimit: '500', cmnamespace: '0', ...cont });
    titles.push(...j.query.categorymembers.map(m => m.title));
    cont = j.continue || null;
  } while (cont);
  return titles;
}

// Turn wikitext into readable plain text, keeping bullet structure.
function clean(s) {
  return s
    .replace(/<gallery[\s\S]*?<\/gallery>/gi, '')
    .replace(/<\/?li[^>]*>/gi, '')
    .replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:Category|[a-z]{2,3}(?:-[a-z]+)?):[^\]]*\]\]/g, '') // category tags and other-language links
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+ ([^\]]*)\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/'''?/g, '')
    .split('\n').map(l => l.trim()).filter(l => l && !/^[{|!]/.test(l))
    .join('\n');
}

function sections(text) {
  const out = {};
  const re = /^(={2,3})\s*(.+?)\s*\1\s*$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const level = m[1].length;
    const name = clean(m[2]);
    const start = m.index + m[0].length;
    // a level-2 section runs until the next level-2 heading
    let end = text.length;
    for (let k = i + 1; k < marks.length; k++) {
      if (marks[k][1].length <= level) { end = marks[k].index; break; }
    }
    if (level === 2) out[name] = text.slice(start, end);
  });
  return out;
}

function infobox(text, field) {
  const m = text.match(new RegExp(`\\|\\s*${field}\\s*=([^\\n]*)`));
  return m ? clean(m[1]) : '';
}

const MAPS = ['Customs', 'Factory', 'Interchange', 'The Lab', 'Lighthouse', 'Reserve', 'Shoreline', 'Streets of Tarkov', 'Woods', 'Ground Zero', 'Terminal'];

function parseKey(title, text) {
  const sec = sections(text);
  const usage = infobox(text, 'usage');
  const lockLoc = clean(sec['Lock Location'] || '');
  const mapHint = MAPS.find(m => (usage + ' ' + lockLoc).includes(m)) || '';
  return {
    title,
    wiki: 'https://escapefromtarkov.fandom.com/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
    usage,
    map: mapHint,
    keyLocation: clean(sec['Key Location'] || ''),
    lockLocation: lockLoc,
    behindLock: clean(sec['Behind the Lock'] || ''),
    quests: clean(sec['Quests'] || ''),
  };
}

const titles = [...new Set([...(await categoryTitles('Category:Keys')), ...(await categoryTitles('Category:Keycards'))])];
console.log(`${titles.length} key pages`);
const keys = [];
for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  const j = await api({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: batch.join('|') });
  for (const p of Object.values(j.query.pages)) {
    const text = p.revisions?.[0]?.slots?.main?.['*'] || '';
    if (text.startsWith('#REDIRECT')) continue;
    keys.push(parseKey(p.title, text));
  }
  console.log(`fetched ${Math.min(i + 50, titles.length)}/${titles.length}`);
}
keys.sort((a, b) => a.title.localeCompare(b.title));
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
if (keys.length < 100) throw new Error(`only ${keys.length} key pages came back; keeping the old cache`);
await saveAtomic(OUT, JSON.stringify(keys, null, 1));
const withLoot = keys.filter(k => k.behindLock).length;
console.log(`wrote ${keys.length} keys, ${withLoot} with "Behind the Lock" text`);
