// The music folders picked in Settings (DATA_DIR/settings.json). Until any are saved there,
// COLLECTIONS from .env is used. Folders can only be picked inside MUSIC_ROOT (default /music),
// which is where docker-compose.yml mounts your music, read-only.
const fs = require('fs');
const path = require('path');
const { DATA_DIR, parseCollections } = require('./scanner');

const FILE = path.join(DATA_DIR, 'settings.json');
const ROOT = path.resolve(process.env.MUSIC_ROOT || '/music');

function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function write(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, FILE);
}

// A folder the page asked for, as a real path inside ROOT, or an error. Stops ../ tricks.
function inside(rel) {
  const full = path.resolve(ROOT, String(rel || '').replace(/^[/\\]+/, ''));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error('That folder is outside the music folders');
  return full;
}
const relOf = (full) => path.relative(ROOT, full).split(path.sep).join('/');

// Before anything is saved in Settings: COLLECTIONS from .env, or else each folder mounted in
// MUSIC_ROOT as a collection of its own (or MUSIC_ROOT itself when nothing is mounted below it).
let envList = null;
function fromEnv() {
  if (envList) return envList;
  if ((process.env.COLLECTIONS || '').trim()) return (envList = parseCollections(process.env.COLLECTIONS));
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { /* no root yet */ }
  // Built directly rather than through parseCollections, so folder names with commas are fine.
  envList = dirs.length ? dirs.map((d) => ({ name: d.replace(/[/]/g, ' '), dir: path.join(ROOT, d) })) : [{ name: 'Music', dir: ROOT }];
  return envList;
}

// The collections to scan: [{ name, dir }].
function collections() {
  const saved = read().collections;
  return Array.isArray(saved) ? saved.map((c) => ({ name: c.name, dir: c.dir })) : fromEnv();
}
function fromSettings() { return Array.isArray(read().collections); }

// Subfolders of one folder, for the folder picker.
async function folders(rel) {
  const full = inside(rel);
  let entries;
  try { entries = await fs.promises.readdir(full, { withFileTypes: true }); } catch (e) {
    throw new Error(e.code === 'ENOENT' ? "That folder isn't there" : `Can't open that folder (${e.code || e.message})`);
  }
  const list = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '@eaDir' && e.name !== '#recycle' && e.name !== '$RECYCLE.BIN' && e.name !== 'System Volume Information')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  return { root: ROOT, path: relOf(full), folders: list };
}

// Save from the page: [{ name, library, folder }] where folder is inside ROOT.
function save(list) {
  if (!Array.isArray(list)) throw new Error('No folders sent');
  if (list.length > 50) throw new Error('That is more than 50 folders');
  const parsed = list.map((c) => {
    const name = String(c.name || '').trim();
    const library = String(c.library || '').trim();
    if (!name) throw new Error('Every folder needs a name');
    if (name.includes('/') || library.includes('/')) throw new Error(`"${library ? `${library} ` : ''}${name}": names can't have a /`);
    const dir = inside(c.folder);
    if (!fs.existsSync(dir)) throw new Error(`The folder for "${name}" isn't there`);
    return { name: library ? `${library}/${name}` : name, dir };
  });
  const seen = new Set();
  for (const c of parsed) {
    if (seen.has(c.name.toLowerCase())) throw new Error(`Two folders are called "${c.name.replace('/', ' ')}"`);
    seen.add(c.name.toLowerCase());
  }
  const withLibrary = parsed.filter((c) => c.name.includes('/')).length;
  if (withLibrary && withLibrary !== parsed.length) throw new Error('Give every folder a library, or none of them');
  write({ ...read(), collections: parsed });
  return parsed;
}

// For the page: each collection with its library, name and folder (relative to ROOT).
function describe() {
  return collections().map((c) => {
    const at = c.name.indexOf('/');
    let folder = null;
    try { const full = path.resolve(c.dir); if (full === ROOT || full.startsWith(ROOT + path.sep)) folder = relOf(full); } catch { /* outside */ }
    return { name: at > 0 ? c.name.slice(at + 1) : c.name, library: at > 0 ? c.name.slice(0, at) : '', folder, dir: c.dir };
  });
}

module.exports = { ROOT, collections, fromSettings, folders, save, describe };
