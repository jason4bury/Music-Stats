// Reads the tags of every audio file in the music folders, read-only, and keeps them in a cache
// (DATA_DIR/library.json) so a rescan only reads files that are new or changed.
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

const AUDIO = /\.(mp3|flac|m4a|mp4|aac|ogg|oga|opus|wma|wav|aiff?|ape|wv|dsf)$/i;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const CACHE = path.join(DATA_DIR, 'library.json');
const CACHE_VERSION = 2; // 2: cover art is detected (version 1 never saw it)
const READERS = Math.min(64, Math.max(1, Number(process.env.SCAN_READERS) || 16)); // files read at once

// "Music=/music/1, Soundtracks=/music/2" -> [{ name, dir }]. A path on its own is called Music.
// Names can also say which library a folder belongs to, as Library/Name ("PC/Music, NAS/Music"),
// for copies of the same music in two places: the page then shows one library at a time.
function parseCollections(text) {
  const list = [];
  for (const part of String(text || '').split(/[,;\n]/)) {
    const item = part.trim();
    if (!item) continue;
    const at = item.indexOf('=');
    const name = (at > 0 ? item.slice(0, at) : list.length ? `Collection ${list.length + 1}` : 'Music').trim();
    const dir = (at > 0 ? item.slice(at + 1) : item).trim();
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error(`COLLECTIONS: two collections are called "${name}"`);
    if (name.split('/').length > 2 || name.startsWith('/') || name.endsWith('/')) throw new Error(`COLLECTIONS: "${name}" can have one / at most, as Library/Name`);
    list.push({ name, dir });
  }
  const withLibrary = list.filter((c) => c.name.includes('/')).length;
  if (withLibrary && withLibrary !== list.length) throw new Error('COLLECTIONS: give every collection a library (Library/Name), or none of them');
  return list;
}

const state = {
  tracks: [],          // what the stats are made from
  scanning: false,
  progress: { done: 0, found: 0, read: 0, errors: 0 },
  lastScan: null,      // { started, finished, seconds, read, kept, errors, offline: [names] }
  error: null,
};

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.version !== CACHE_VERSION) return { files: {}, lastScan: null };
    return c;
  } catch { return { files: {}, lastScan: null }; }
}
function saveCache(files, lastScan) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CACHE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, lastScan, files }));
  fs.renameSync(tmp, CACHE);
}

// A picture beside the music (cover.jpg, folder.jpg, front.png, AlbumArt_...jpg and so on) counts as cover art.
const COVER = /^(cover|folder|front|album|albumart.*|artwork)\.(jpe?g|png|webp|gif|bmp)$/i;

function coverRank(name) { const n = name.toLowerCase(); return n.startsWith('cover') ? 0 : n.startsWith('folder') ? 1 : n.startsWith('front') ? 2 : 3; }

// An artist's picture in their folder: artist.jpg (or .jpeg, .png, .webp).
const ARTIST_PIC = /^artist\.(jpe?g|png|webp)$/i;

// Every audio file under dir, with whether its folder has a cover picture, and the nearest artist
// picture above it (as a path inside the collection).
async function* walk(dir, root = dir, artistPic = null) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  // The folder's cover picture, preferring cover/folder/front over the rest (as a path inside the collection).
  const covers = entries.filter((e) => e.isFile() && COVER.test(e.name)).map((e) => e.name)
    .sort((a, b) => coverRank(a) - coverRank(b) || a.localeCompare(b));
  const folderCover = covers.length ? path.relative(root, path.join(dir, covers[0])).split(path.sep).join('/') : null;
  const pic = entries.find((e) => e.isFile() && ARTIST_PIC.test(e.name));
  if (pic) artistPic = path.relative(root, path.join(dir, pic.name)).split(path.sep).join('/');
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '@eaDir' || e.name === '#recycle') continue; // hidden and Synology system folders
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, root, artistPic);
    else if (e.isFile() && AUDIO.test(e.name)) yield { full, folderCover, artistPic };
  }
}

function first(v) { return Array.isArray(v) ? (v.length ? v[0] : null) : v || null; }
function clean(v) { const s = v == null ? '' : String(v).replace(/\0/g, '').trim(); return s || null; }

// The few tags the stats use. Short keys keep the cache small for big libraries.
async function readTags(file) {
  // Covers are read only to see whether there is one; the picture itself is not kept.
  const m = await mm.parseFile(file, { duration: false, skipCovers: false, skipPostHeaders: true });
  const c = m.common;
  const f = m.format;
  let year = c.year || (c.date ? parseInt(String(c.date).slice(0, 4), 10) : null);
  if (!(year > 1000 && year < 3000)) year = null;
  return {
    t: clean(c.title),
    a: clean(c.artist || (c.artists && c.artists.join(', '))),
    aa: clean(c.albumartist),
    al: clean(c.album),
    y: year,
    g: clean(first(c.genre)),
    d: f.duration ? Math.round(f.duration) : null,
    b: f.bitrate ? Math.round(f.bitrate / 1000) : null,
    v: f.codecProfile && /V\d|VBR/i.test(f.codecProfile) ? 1 : 0,
    p: !!(c.picture && c.picture.length) || null,
  };
}

function toTrack(collection, rel, entry) {
  // p: has cover art; ep: the cover is inside the file; fc: the folder's cover picture.
  return { c: collection, f: rel, s: entry.size, m: entry.mtime, ...entry.tags, p: entry.tags.p || !!entry.fc || null, ep: entry.tags.p || null, fc: typeof entry.fc === 'string' ? entry.fc : null, ap: entry.ap || null };
}

// Scan every collection. A collection whose folder is missing or empty keeps its last tracks,
// so an unplugged drive or a NAS that's asleep doesn't wipe the stats.
// Called again while scanning (folders changed in Settings), it scans once more when this one ends.
let again = null;
async function scan(collections) {
  if (state.scanning) { again = collections; return; }
  state.scanning = true;
  state.error = null;
  state.progress = { phase: 'counting', done: 0, found: 0, read: 0, errors: 0 };
  const started = Date.now();
  const cache = loadCache();
  const files = {};
  const offline = [];
  try {
    // 1. Count: list every file first, so the page can show a real progress bar.
    const todo = [];
    for (const col of collections) {
      const prefix = `${col.name}\u0000`;
      let found = 0;
      for await (const { full, folderCover, artistPic } of walk(col.dir)) {
        found++; state.progress.found++;
        const rel = path.relative(col.dir, full).split(path.sep).join('/');
        todo.push({ full, key: prefix + rel, folderCover, artistPic });
      }
      if (!found) {
        offline.push(col.name);
        for (const [k, v] of Object.entries(cache.files)) if (k.startsWith(prefix)) files[k] = v; // keep what we had
      }
    }
    // 2. Read: a steady number of files at once, each worker taking the next file as soon as it's
    //    free (a slow file over the network no longer holds up the rest).
    state.progress.phase = 'reading';
    let next = 0;
    let savedAt = 0;
    const worker = async () => {
      while (next < todo.length) {
        await readOne(todo[next++], cache.files, files);
        // On a first scan, save as it goes, so a restart part-way doesn't start again from nothing.
        if (state.progress.read - savedAt >= 2000) {
          savedAt = state.progress.read;
          saveCache({ ...cache.files, ...files }, cache.lastScan);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READERS, todo.length) }, worker));
    const lastScan = {
      started: new Date(started).toISOString(), finished: new Date().toISOString(),
      seconds: Math.round((Date.now() - started) / 1000),
      read: state.progress.read, kept: Object.keys(files).length - state.progress.read, errors: state.progress.errors, offline,
    };
    // Keep what's cached for folders not scanned this time (taken off in Settings, or changed during
    // this scan), so adding one back doesn't mean reading all its files again.
    const scanned = collections.map((c) => `${c.name}\u0000`);
    const kept = Object.fromEntries(Object.entries(cache.files).filter(([k]) => !scanned.some((p) => k.startsWith(p))));
    saveCache({ ...kept, ...files }, lastScan);
    state.lastScan = lastScan;
    state.tracks = tracksFrom(files);
  } catch (e) {
    state.error = e.message;
    console.error('Scan failed:', e);
  } finally {
    state.scanning = false;
    if (again) { const next = again; again = null; scan(next); }
  }
}

async function readOne({ full, key, folderCover, artistPic }, old, files) {
  try {
    const st = await fs.promises.stat(full);
    const mtime = Math.round(st.mtimeMs);
    const was = old[key];
    if (was && was.size === st.size && was.mtime === mtime) files[key] = { ...was, fc: folderCover || undefined, ap: artistPic || undefined };
    else {
      files[key] = { size: st.size, mtime, fc: folderCover || undefined, ap: artistPic || undefined, tags: await readTags(full) };
      state.progress.read++;
    }
  } catch (e) {
    state.progress.errors++;
    if (state.progress.errors <= 20) console.warn(`Couldn't read ${full}: ${e.message}`);
  } finally {
    state.progress.done++;
  }
}

function tracksFrom(files) {
  return Object.entries(files).map(([key, entry]) => {
    const at = key.indexOf('\u0000');
    return toTrack(key.slice(0, at), key.slice(at + 1), entry);
  });
}

function loadFromCache() {
  const c = loadCache();
  state.tracks = tracksFrom(c.files);
  state.lastScan = c.lastScan;
}

module.exports = { parseCollections, scan, loadFromCache, state, DATA_DIR, AUDIO, ARTIST_PIC, COVER };
