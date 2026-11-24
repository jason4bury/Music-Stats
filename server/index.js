require('dotenv').config();
const path = require('path');
const express = require('express');
const { settingsProblems, requireAuth, login, logout, signInOff } = require('./auth');
const scanner = require('./scanner');
const stats = require('./stats');
const settings = require('./settings');
const { DISPLAY_VERSION } = require('./version');

const APP = 'Music Stats';

// Refuse to start with missing sign-in settings or music folders, saying what to fix.
const problems = settingsProblems();
try {
  settings.collections();
} catch (e) { problems.push(e.message); }
if (problems.length) {
  console.error(`${APP} cannot start:\n  - ` + problems.join('\n  - '));
  console.error('Set these in your .env file (see .env.example), then start the container again.');
  process.exit(1);
}

// Libraries: the part before the / in Library/Name collection names (none when names have no /).
function librariesOf(list) { return [...new Set(list.filter((c) => c.name.includes('/')).map((c) => c.name.split('/')[0]))]; }

const PORT = Number(process.env.PORT) || 3050;
const SCAN_HOURS = Math.max(0, Number(process.env.SCAN_HOURS ?? 24));

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '10kb' }));

// Unauthenticated: the sign-in page and its endpoints, and a health check for Docker and monitors.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.post('/api/login', login);
app.post('/api/logout', logout);
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/favicon.ico', express.static(path.join(__dirname, '..', 'public', 'favicon.ico')));
app.use('/apple-touch-icon.png', express.static(path.join(__dirname, '..', 'public', 'apple-touch-icon.png')));

app.use(requireAuth);

function filtersFrom(q) {
  const f = {};
  for (const k of ['library', 'collection', 'decade', 'year', 'genre', 'artist', 'album', 'format', 'letter', 'q']) {
    if (typeof q[k] === 'string' && q[k].trim()) f[k] = q[k].trim().slice(0, 200);
  }
  const libraries = librariesOf(settings.collections());
  // With libraries, the page always shows one of them (they're copies, so adding them up would count twice).
  if (libraries.length && !libraries.includes(f.library)) f.library = libraries[0];
  if (!libraries.length) delete f.library;
  if (f.collection && f.library && !f.collection.startsWith(`${f.library}/`)) delete f.collection;
  return f;
}

// Stats are worked out again only when the tracks or the filters change.
const memo = new Map();
let memoFor = null;
app.get('/api/stats', (req, res) => {
  if (memoFor !== scanner.state.tracks) { memo.clear(); memoFor = scanner.state.tracks; }
  const f = filtersFrom(req.query);
  const key = JSON.stringify(f);
  if (!memo.has(key)) { if (memo.size > 200) memo.clear(); memo.set(key, stats.build(scanner.state.tracks, f)); }
  res.json({ filters: f, ...memo.get(key), scan: scanStatus() });
});

function scanStatus() {
  const s = scanner.state;
  return { scanning: s.scanning, progress: s.progress, last: s.lastScan, error: s.error, everyHours: SCAN_HOURS };
}
app.get('/api/scan', (_req, res) => res.json(scanStatus()));

// An artist's picture: c is the collection, p the picture's path inside it. Only artist.jpg-style
// files inside a collection's folder are ever sent.
app.get('/api/picture', (req, res) => {
  const col = settings.collections().find((x) => x.name === req.query.c);
  const rel = String(req.query.p || '');
  if (!col || !scanner.ARTIST_PIC.test(path.basename(rel))) return res.status(404).end();
  const root = path.resolve(col.dir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return res.status(404).end();
  res.sendFile(full, { maxAge: '1d', dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
// An album cover: p is a picture beside the music (cover.jpg, folder.jpg and the like), f a music
// file whose own picture is sent. Both must be inside one of the collections' folders.
const mm = require('music-metadata');
const embedded = new Map(); // a few recent covers from inside files, so a page refresh is quick
app.get('/api/cover', async (req, res) => {
  const col = settings.collections().find((x) => x.name === req.query.c);
  if (!col) return res.status(404).end();
  const root = path.resolve(col.dir);
  const rel = String(req.query.p || req.query.f || '');
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return res.status(404).end();
  if (req.query.p) {
    if (!scanner.COVER.test(path.basename(rel))) return res.status(404).end();
    return res.sendFile(full, { maxAge: '1d', dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }
  if (!scanner.AUDIO.test(rel)) return res.status(404).end();
  try {
    let pic = embedded.get(full);
    if (!pic) {
      const m = await mm.parseFile(full, { duration: false, skipPostHeaders: true });
      const p = m.common.picture && m.common.picture[0];
      if (!p) return res.status(404).end();
      pic = { type: p.format && p.format.startsWith('image/') ? p.format : 'image/jpeg', data: Buffer.from(p.data) };
      embedded.set(full, pic);
      if (embedded.size > 200) embedded.delete(embedded.keys().next().value);
    }
    res.set('Cache-Control', 'max-age=86400').type(pic.type).send(pic.data);
  } catch { res.status(404).end(); }
});

app.post('/api/scan', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
  if (!scanner.state.scanning) scanner.scan(settings.collections());
  res.json(scanStatus());
});
app.get('/api/about', (_req, res) => {
  const list = settings.collections();
  res.json({ app: APP, version: DISPLAY_VERSION, signIn: !signInOff, collections: list.map((c) => c.name), libraries: librariesOf(list) });
});

// --- Settings: which music folders to read ---
app.get('/api/settings', (_req, res) => res.json({ root: settings.ROOT, fromSettings: settings.fromSettings(), collections: settings.describe() }));
app.get('/api/folders', async (req, res) => {
  try { res.json(await settings.folders(typeof req.query.path === 'string' ? req.query.path : '')); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/settings/collections', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
  try {
    const list = settings.save(req.body && req.body.collections);
    // Tracks from folders no longer listed drop out as the rescan finishes.
    scanner.scan(list);
    res.json({ ok: true, collections: settings.describe() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

scanner.loadFromCache();
app.listen(PORT, () => {
  const list = settings.collections();
  console.log(`${APP} v${DISPLAY_VERSION} on port ${PORT}: ${list.length ? list.map((c) => `${c.name} (${c.dir})`).join(', ') : 'no music folders yet (pick them in Settings)'}${signInOff ? ' (sign-in is off)' : ''}`);
  console.log(`${scanner.state.tracks.length} tracks from the last scan; scanning now${SCAN_HOURS ? ` and every ${SCAN_HOURS} hours` : ''}.`);
  scanner.scan(list);
  if (SCAN_HOURS) setInterval(() => scanner.scan(settings.collections()), SCAN_HOURS * 3600 * 1000).unref();
});
