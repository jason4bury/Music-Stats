// Turns the scanned tracks into the numbers the page shows, for everything or a filtered part.
const TOP = 25;

function artistOf(t) { return t.a || t.aa || null; }
function albumArtistOf(t) { return t.aa || t.a || null; }
function formatOf(t) { const m = /\.([^./]+)$/.exec(t.f); return m ? m[1].toUpperCase() : '?'; }
function decadeOf(y) { return y ? Math.floor(y / 10) * 10 : null; }
// The letter an artist is filed under: "The Beatles" under B, numbers and symbols under #.
function letterOf(t) {
  const a = (artistOf(t) || '').replace(/^the\s+/i, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!a) return null;
  const c = a[0].toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}
const LENGTHS = [[0, 120, 'Under 2 min'], [120, 180, '2-3 min'], [180, 240, '3-4 min'], [240, 300, '4-5 min'], [300, 420, '5-7 min'], [420, 600, '7-10 min'], [600, Infinity, 'Over 10 min']];
const DAY = 86400000;

// Filters come from the page: library, collection, decade, year, genre, artist, album, format, letter, q (any text).
function matches(t, f) {
  if (f.library && !t.c.startsWith(`${f.library}/`)) return false;
  if (f.collection && t.c !== f.collection) return false;
  if (f.decade && decadeOf(t.y) !== Number(f.decade)) return false;
  if (f.year && t.y !== Number(f.year)) return false;
  if (f.genre && (t.g || '').toLowerCase() !== f.genre.toLowerCase()) return false;
  if (f.artist && (artistOf(t) || '').toLowerCase() !== f.artist.toLowerCase()) return false;
  if (f.album && (t.al || '').toLowerCase() !== f.album.toLowerCase()) return false;
  if (f.format && formatOf(t) !== f.format.toUpperCase()) return false;
  if (f.letter && letterOf(t) !== f.letter.toUpperCase()) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (![t.a, t.aa, t.al, t.t, t.g].some((v) => v && v.toLowerCase().includes(q))) return false;
  }
  return true;
}

// Group by a key, keeping the first spelling seen for keys that differ only in case.
// Each artist's picture, as { c, p } (collection and path inside it): the one most of their tracks sit under.
function artistPictures(tracks) {
  const votes = new Map();
  for (const t of tracks) {
    if (!t.ap) continue;
    const a = (artistOf(t) || '').toLowerCase();
    if (!a) continue;
    let m = votes.get(a);
    if (!m) votes.set(a, (m = new Map()));
    const k = `${t.c}\u0000${t.ap}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const out = new Map();
  for (const [a, m] of votes) {
    const best = [...m].sort((x, y) => y[1] - x[1])[0][0];
    const at = best.indexOf('\u0000');
    out.set(a, { c: best.slice(0, at), p: best.slice(at + 1) });
  }
  return out;
}

// A cover for an album or a track: { c, p } for a picture beside the music, { c, f } for one inside a file.
function coverOf(t) {
  if (t.fc) return { c: t.c, p: t.fc };
  if (t.ep) return { c: t.c, f: t.f };
  return null;
}
function albumCovers(tracks) {
  const out = new Map();
  for (const t of tracks) {
    if (!t.al) continue;
    const k = `${(albumArtistOf(t) || '').toLowerCase()}\u0000${t.al.toLowerCase()}`;
    const have = out.get(k);
    if (have && have.p) continue; // a picture file beats a cover inside a file
    const c = coverOf(t);
    if (c && (!have || c.p)) out.set(k, c);
  }
  return out;
}

function group(tracks, keyOf) {
  const map = new Map();
  for (const t of tracks) {
    const key = keyOf(t);
    if (key == null || key === '') continue;
    const id = String(key).toLowerCase();
    let g = map.get(id);
    if (!g) { g = { name: key, tracks: 0, seconds: 0, bytes: 0, albums: new Set(), artists: new Set(), from: null, to: null }; map.set(id, g); }
    g.tracks++;
    g.seconds += t.d || 0;
    g.bytes += t.s || 0;
    if (t.al) g.albums.add(`${(albumArtistOf(t) || '').toLowerCase()}\u0000${t.al.toLowerCase()}`);
    const ar = artistOf(t);
    if (ar) g.artists.add(ar.toLowerCase());
    if (t.y) { if (g.from == null || t.y < g.from) g.from = t.y; if (g.to == null || t.y > g.to) g.to = t.y; }
  }
  return [...map.values()].map((g) => ({
    name: g.name, tracks: g.tracks, seconds: g.seconds, bytes: g.bytes, albums: g.albums.size, artists: g.artists.size,
    from: g.from, to: g.to,
  }));
}
const byTracks = (a, b) => b.tracks - a.tracks || String(a.name).localeCompare(String(b.name));

const LOSSLESS = /^(FLAC|WAV|AIF|AIFF|APE|WV|DSF)$/;
function bitrateBand(t) {
  if (LOSSLESS.test(formatOf(t))) return 'Lossless';
  if (!t.b) return null;
  if (t.v) return 'VBR';
  if (t.b >= 320) return '320 kbps';
  if (t.b >= 256) return '256 kbps';
  if (t.b >= 192) return '192 kbps';
  if (t.b >= 128) return '128 kbps';
  return 'Under 128 kbps';
}

function build(all, f = {}) {
  const tracks = all.filter((t) => matches(t, f));
  const albums = group(tracks, (t) => (t.al ? `${albumArtistOf(t) || ''}\u0000${t.al}` : null))
    .map((g) => { const [artist, album] = g.name.split('\u0000'); return { ...g, name: album, artist }; });
  const covers = albumCovers(tracks);
  for (const a of albums) a.cover = covers.get(`${(a.artist || '').toLowerCase()}\u0000${a.name.toLowerCase()}`) || null;
  const artists = group(tracks, artistOf);
  const pics = artistPictures(tracks);
  for (const a of artists) a.pic = pics.get(String(a.name).toLowerCase()) || null;
  const genres = group(tracks, (t) => t.g);
  const decades = group(tracks, (t) => decadeOf(t.y)).sort((a, b) => a.name - b.name);
  const years = group(tracks, (t) => t.y).sort((a, b) => a.name - b.name);
  const added = group(tracks, (t) => (t.m ? new Date(t.m).getFullYear() : null)).sort((a, b) => a.name - b.name);
  const formats = group(tracks, formatOf).sort(byTracks);
  const bitrates = group(tracks, bitrateBand).sort(byTracks);
  const collections = group(f.library ? all.filter((t) => t.c.startsWith(`${f.library}/`)) : all, (t) => t.c).sort(byTracks);
  const missing = {
    artist: tracks.filter((t) => !t.a && !t.aa),
    album: tracks.filter((t) => !t.al),
    year: tracks.filter((t) => !t.y),
    genre: tracks.filter((t) => !t.g),
    title: tracks.filter((t) => !t.t),
    cover: tracks.filter((t) => !t.p),
  };
  // The artist picked on the page, for the header above their stats.
  // The album picked on the page, for the header above its stats.
  const album = f.album ? [...albums].sort(byTracks).find((a) => a.name.toLowerCase() === f.album.toLowerCase()) || null : null;
  const artist = f.artist ? artists.find((a) => String(a.name).toLowerCase() === f.artist.toLowerCase()) || null : null;
  const noPic = artists.filter((a) => !a.pic).sort(byTracks);
  // Where each artist's picture would go: the top folder most of their files are in.
  const wanted = new Set(noPic.slice(0, 200).map((a) => String(a.name).toLowerCase()));
  const folderVotes = new Map();
  for (const t of tracks) {
    const a = (artistOf(t) || '').toLowerCase();
    if (!wanted.has(a)) continue;
    const parts = t.f.split('/');
    const folder = parts.length > 1 ? `${t.c}/${parts[0]}` : t.c;
    let m = folderVotes.get(a);
    if (!m) folderVotes.set(a, (m = new Map()));
    m.set(folder, (m.get(folder) || 0) + 1);
  }
  const folderOf = (name) => { const m = folderVotes.get(String(name).toLowerCase()); return m ? [...m].sort((x, y) => y[1] - x[1])[0][0] : null; };
  const sample = (list) => list.slice(0, 50).map((t) => ({ collection: t.c, file: t.f, artist: artistOf(t), album: t.al, title: t.t }));
  // A loop rather than Math.min(...list), which fails on very big libraries.
  let oldest = null, newest = null, timed = 0;
  for (const t of tracks) {
    if (t.y) { if (oldest == null || t.y < oldest) oldest = t.y; if (newest == null || t.y > newest) newest = t.y; }
    if (t.d) timed++;
  }
  const seconds = tracks.reduce((s, t) => s + (t.d || 0), 0);

  // Recently added: albums with files from the last 30 days, newest first.
  const since = Date.now() - 30 * DAY;
  const recent = tracks.filter((t) => t.m && t.m >= since);
  const recentAlbums = new Map();
  for (const t of recent) {
    const k = `${(albumArtistOf(t) || '').toLowerCase()}\u0000${(t.al || t.f.split('/').slice(0, -1).join('/')).toLowerCase()}`;
    let g = recentAlbums.get(k);
    if (!g) recentAlbums.set(k, (g = { name: t.al || t.f.split('/').slice(-2, -1)[0] || '(no album)', album: t.al || null, artist: albumArtistOf(t), tracks: 0, added: 0, cover: null }));
    if (!g.cover || (!g.cover.p && t.fc)) g.cover = coverOf(t) || g.cover;
    g.tracks++;
    if (t.m > g.added) g.added = t.m;
  }

  // Genres by decade: the top genres down the side, decades across.
  const topGenres = [...genres].sort(byTracks).slice(0, 12).map((g) => g.name);
  const gridDecades = decades.map((d) => d.name);
  const cells = new Map();
  for (const t of tracks) {
    if (!t.g || !t.y) continue;
    const k = `${t.g.toLowerCase()}\u0000${decadeOf(t.y)}`;
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  const genreDecades = {
    decades: gridDecades,
    rows: topGenres.map((g) => ({ name: g, counts: gridDecades.map((d) => cells.get(`${g.toLowerCase()}\u0000${d}`) || 0) })),
  };

  // Track lengths.
  const lengths = LENGTHS.map(([from, to, name]) => ({ name, tracks: tracks.filter((t) => t.d && t.d >= from && t.d < to).length }));
  const shortest = tracks.filter((t) => t.d && t.d >= 5).sort((a, b) => a.d - b.d).slice(0, 10)
    .map((t) => ({ title: t.t || t.f.split('/').pop(), artist: artistOf(t), album: t.al, seconds: t.d }));

  // Artists A to Z (artists, not tracks), with every letter present so the chart keeps its shape.
  const byLetter = new Map([...'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => [c, new Set()]));
  for (const t of tracks) { const l = letterOf(t); if (l) byLetter.get(l).add((artistOf(t) || '').toLowerCase()); }
  const letters = [...byLetter].map(([name, set]) => ({ name, artists: set.size }));

  return {
    totals: {
      tracks: tracks.length, albums: albums.length, artists: artists.length, genres: genres.length,
      seconds, bytes: tracks.reduce((s, t) => s + (t.s || 0), 0),
      oldest, newest,
      averageSeconds: timed ? Math.round(seconds / timed) : 0,
    },
    collections,
    decades, years, added,
    genres: genres.sort(byTracks).slice(0, TOP),
    artists: {
      byTracks: [...artists].sort(byTracks).slice(0, TOP),
      byTime: [...artists].sort((a, b) => b.seconds - a.seconds).slice(0, TOP),
      byAlbums: [...artists].sort((a, b) => b.albums - a.albums || b.tracks - a.tracks).slice(0, TOP),
      bySize: [...artists].sort((a, b) => b.bytes - a.bytes).slice(0, TOP),
    },
    albums: albums.sort((a, b) => b.tracks - a.tracks || b.seconds - a.seconds).slice(0, TOP),
    formats, bitrates,
    recent: { tracks: recent.length, albums: [...recentAlbums.values()].sort((a, b) => b.added - a.added).slice(0, 20) },
    genreDecades, lengths, shortest, letters,
    longest: tracks.filter((t) => t.d).sort((a, b) => b.d - a.d).slice(0, 10)
      .map((t) => ({ title: t.t || t.f.split('/').pop(), artist: artistOf(t), album: t.al, seconds: t.d })),
    missing: Object.fromEntries(Object.entries(missing).map(([k, list]) => [k, { count: list.length, examples: sample(list) }])),
    noArtistPicture: { count: noPic.length, of: artists.length, examples: noPic.slice(0, 200).map((a) => ({ artist: a.name, tracks: a.tracks, folder: folderOf(a.name) })) },
    artist,
    album,
  };
}

module.exports = { build };
