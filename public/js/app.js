// Music Stats: draws /api/stats as tiles, charts and top lists; clicking a bar narrows everything to it.
(() => {
  const $ = (id) => document.getElementById(id);
  const filters = {};
  let data = null;
  let artistRank = load('ms-artist-rank', 'byTracks');
  let pollTimer = null;
  const openMissing = new Set();

  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* no storage */ } }

  // Build elements without innerHTML, so tags from files can never become markup.
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }

  const num = (n) => Number(n || 0).toLocaleString();
  function bytes(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; n = n || 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }
  function span(seconds) {
    seconds = seconds || 0;
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.round((seconds % 3600) / 60);
    const p = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;
    if (d) return `${p(d, 'day')} ${p(h, 'hour')}`;
    if (h) return `${p(h, 'hour')} ${m} min`;
    return `${m} min`;
  }
  function clock(seconds) {
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const decadeName = (d) => `${d}s`;

  // --- Filters ---
  const labels = { decade: 'Decade', year: 'Year', genre: 'Genre', artist: 'Artist', album: 'Album', format: 'Format', letter: 'Artists starting' };
  function setFilter(key, value) {
    if (filters[key] === String(value)) delete filters[key]; else filters[key] = String(value);
    if (key === 'decade') delete filters.year;
    if (key === 'year') delete filters.decade;
    refresh();
  }
  function drawFilters() {
    const keys = Object.keys(labels).filter((k) => filters[k]);
    $('filters').hidden = !keys.length;
    $('filters').replaceChildren(
      el('span', { class: 'muted small', text: 'Showing only:' }),
      ...keys.map((k) => el('span', { class: 'chip' }, `${labels[k]}${k === 'letter' ? ' with' : ':'} ${k === 'decade' ? decadeName(filters[k]) : filters[k]}`,
        el('button', { type: 'button', 'aria-label': `Remove ${labels[k]}`, text: '×', onclick: () => { delete filters[k]; refresh(); } }))),
      el('button', { class: 'btn small', type: 'button', text: 'Clear all', onclick: () => { for (const k of keys) delete filters[k]; refresh(); } }));
  }

  // --- Charts ---
  function card(title, body, extra, wide) {
    return el('section', { class: `card${wide ? ' wide' : ''}` }, el('header', {}, el('h2', { text: title }), extra || null), body);
  }
  function empty(text) { return el('p', { class: 'muted small', text: text || 'Nothing to show.' }); }

  // Horizontal bars: rows of { name, value, label, sub, onclick }.
  function hbars(rows, opts = {}) {
    if (!rows.length) return empty(opts.empty);
    const max = Math.max(...rows.map((r) => r.value)) || 1;
    return el('ol', { class: `hbars${opts.numbered ? ' numbered' : ''}` }, rows.map((r) => el('li', {},
      el('button', { type: 'button', class: `hbar${r.active ? ' active' : ''}`, onclick: r.onclick, title: r.title || null, disabled: r.onclick ? null : 'disabled' },
        el('span', { class: 'hname' }, r.avatar !== undefined ? avatar(r.avatar, r.name) : r.cover !== undefined ? coverImg(r.cover, r.name) : null, r.name, r.sub ? el('small', { text: r.sub }) : null),
        el('span', { class: 'htrack' }, el('span', { class: 'hfill', style: `width:${Math.max(1.5, (r.value / max) * 100)}%` })),
        el('span', { class: 'hval', text: r.label })))));
  }

  // An artist's picture (or their initials when there's none).
  const picUrl = (pic) => `/api/picture?c=${encodeURIComponent(pic.c)}&p=${encodeURIComponent(pic.p)}`;
  function avatar(pic, name, big) {
    const cls = `avatar${big ? ' big' : ''}`;
    if (pic) return el('img', { class: cls, src: picUrl(pic), alt: '', loading: 'lazy', decoding: 'async' });
    const initials = String(name || '?').replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
    return el('span', { class: `${cls} none`, 'aria-hidden': 'true', text: initials || '?' });
  }

  // An album cover (a music note when there's none).
  const coverUrl = (c) => (c.p ? `/api/cover?c=${encodeURIComponent(c.c)}&p=${encodeURIComponent(c.p)}` : `/api/cover?c=${encodeURIComponent(c.c)}&f=${encodeURIComponent(c.f)}`);
  function coverImg(c, name, big) {
    const cls = `cover${big ? ' big' : ''}`;
    if (!c) return el('span', { class: `${cls} none`, 'aria-hidden': 'true', text: '\u266A' });
    const img = el('img', { class: cls, src: coverUrl(c), alt: big ? `Cover of ${name}` : '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(el('span', { class: `${cls} none`, 'aria-hidden': 'true', text: '\u266A' })));
    return img;
  }

  // Vertical bars for decades and years.
  function vbars(rows, opts = {}) {
    if (!rows.length) return empty('No years in the tags yet.');
    const max = Math.max(...rows.map((r) => r.value)) || 1;
    return el('div', { class: `vbars${opts.thin ? ' thin' : ''}${opts.labels ? ' labels' : ''}` }, rows.map((r) => el('button', {
      type: 'button', class: `vbar${r.active ? ' active' : ''}`, onclick: r.onclick, title: r.title, disabled: r.onclick ? null : 'disabled',
    },
    el('span', { class: 'vcol' }, el('span', { class: 'vfill', style: `height:${Math.max(1, (r.value / max) * 100)}%` })),
    opts.thin ? null : el('span', { class: 'vval', text: num(r.value) }),
    el('span', { class: 'vname', text: r.name }))));
  }

  // Genres by decade: a grid, darker where there's more; click a square for that genre in that decade.
  function genreGrid(g) {
    if (!g.rows.length || !g.decades.length) return empty('Needs genres and years in the tags.');
    const max = Math.max(1, ...g.rows.flatMap((r) => r.counts));
    return el('div', { class: 'grid-wrap' }, el('table', { class: 'heat' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }), g.decades.map((d) => el('th', { scope: 'col', text: decadeName(d) })))),
      el('tbody', {}, g.rows.map((r) => el('tr', {},
        el('th', { scope: 'row', text: r.name }),
        r.counts.map((n, i) => el('td', {}, n ? el('button', {
          type: 'button', class: 'cell', title: `${r.name}, ${decadeName(g.decades[i])}: ${num(n)} tracks`,
          style: `--heat:${(0.12 + 0.88 * Math.sqrt(n / max)).toFixed(2)}`, 'data-hot': Math.sqrt(n / max) > 0.55 ? '1' : null,
          onclick: () => { filters.genre = r.name; filters.decade = String(g.decades[i]); delete filters.year; refresh(); },
          text: num(n),
        }) : el('span', { class: 'cell empty', text: '·' }))))))));
  }

  // Years: one bar per year from the oldest to the newest, with gaps for years with none.
  function yearRows(years) {
    if (!years.length) return [];
    const by = new Map(years.map((y) => [y.name, y]));
    const rows = [];
    for (let y = years[0].name; y <= years[years.length - 1].name; y++) {
      const g = by.get(y);
      rows.push({ name: y % 10 === 0 || years[years.length - 1].name - years[0].name < 15 ? String(y) : '', value: g ? g.tracks : 0, title: `${y}: ${num(g ? g.tracks : 0)} tracks`, active: filters.year === String(y), onclick: () => setFilter('year', y) });
    }
    return rows;
  }

  function draw() {
    if (!data) return;
    drawFilters();
    const t = data.totals;
    const tile = (n, l, title) => el('div', { class: 'tile', title: title || null }, el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l }));
    // The album picked: its cover and numbers above everything else (after the artist, if both).
    const al = data.album;
    $('albumHead').hidden = !al;
    if (al) {
      $('albumHead').replaceChildren(coverImg(al.cover, al.name, true), el('div', {},
        el('h2', { text: al.name }),
        el('p', {}, al.artist ? el('button', { type: 'button', class: 'linkish', text: al.artist, onclick: () => { filters.artist = al.artist; delete filters.album; refresh(); } }) : null),
        el('p', { class: 'muted', text: [al.from ? (al.from === al.to ? String(al.from) : `${al.from} to ${al.to}`) : null,
          `${num(al.tracks)} ${al.tracks === 1 ? 'track' : 'tracks'}`, span(al.seconds), bytes(al.bytes)].filter(Boolean).join(' \u00B7 ') })),
      el('button', { class: 'btn small', type: 'button', text: 'All albums', onclick: () => { delete filters.album; refresh(); } }));
    }

    // The artist picked: their picture and numbers above everything else.
    const a = data.artist;
    $('artistHead').hidden = !a;
    if (a) {
      $('artistHead').replaceChildren(avatar(a.pic, a.name, true), el('div', {},
        el('h2', { text: a.name }),
        el('p', { class: 'muted', text: [a.from ? (a.from === a.to ? String(a.from) : `${a.from} to ${a.to}`) : null,
          `${num(a.tracks)} ${a.tracks === 1 ? 'track' : 'tracks'}`, `${num(a.albums)} ${a.albums === 1 ? 'album' : 'albums'}`, span(a.seconds), bytes(a.bytes)].filter(Boolean).join(' \u00B7 ') })),
      el('button', { class: 'btn small', type: 'button', text: 'All artists', onclick: () => { delete filters.artist; refresh(); } }));
    }
    $('summary').replaceChildren(
      tile(num(t.tracks), 'tracks'),
      tile(num(t.albums), 'albums'),
      tile(num(t.artists), 'artists'),
      tile(num(t.genres), 'genres'),
      tile(span(t.seconds), 'of music', `Average track ${clock(t.averageSeconds || 0)}`),
      tile(bytes(t.bytes), 'on disk'),
      tile(t.oldest ? `${t.oldest} to ${t.newest}` : '-', 'years'),
    );

    if (!t.tracks) {
      const scanning = data.scan.scanning;
      $('cards').replaceChildren(el('div', { class: 'card wide' }, el('p', { text: scanning ? 'Reading your music for the first time. The numbers appear as soon as it finishes.'
        : Object.keys(filters).length || filters.q ? 'Nothing matches. Try removing a filter or changing the search.' : 'No music found yet. Check the music folders in docker-compose.yml, then press Rescan.' })));
      return;
    }

    const cards = [];
    cards.push(card('Decades', vbars(data.decades.map((d) => ({
      name: decadeName(d.name), value: d.tracks, title: `${decadeName(d.name)}: ${num(d.tracks)} tracks, ${num(d.albums)} albums`,
      active: filters.decade === String(d.name), onclick: () => setFilter('decade', d.name),
    })))));
    cards.push(card('Genres', hbars(data.genres.map((g) => ({
      name: g.name, value: g.tracks, label: num(g.tracks), sub: `${num(g.artists)} ${g.artists === 1 ? 'artist' : 'artists'}`,
      active: (filters.genre || '').toLowerCase() === g.name.toLowerCase(), onclick: () => setFilter('genre', g.name),
    })), { empty: 'No genres in the tags.' })));
    cards.push(card('Years', vbars(yearRows(data.years), { thin: true }), null, true));
    cards.push(card('Genres by decade', genreGrid(data.genreDecades), null, true));

    const ranks = { byTracks: 'Tracks', byTime: 'Time', byAlbums: 'Albums', bySize: 'Size' };
    const rankButtons = el('div', { class: 'seg', role: 'group', 'aria-label': 'Rank artists by' }, Object.entries(ranks).map(([k, l]) =>
      el('button', { type: 'button', class: k === artistRank ? 'on' : '', 'aria-pressed': String(k === artistRank), text: l, onclick: () => { artistRank = k; save('ms-artist-rank', k); draw(); } })));
    const artistList = data.artists[artistRank] || [];
    cards.push(card('Top artists', hbars(artistList.map((a) => ({
      name: a.name, value: artistRank === 'byTime' ? a.seconds : artistRank === 'byAlbums' ? a.albums : artistRank === 'bySize' ? a.bytes : a.tracks,
      label: artistRank === 'byTime' ? span(a.seconds) : artistRank === 'byAlbums' ? `${num(a.albums)} ${a.albums === 1 ? 'album' : 'albums'}` : artistRank === 'bySize' ? bytes(a.bytes) : num(a.tracks),
      sub: a.from ? (a.from === a.to ? String(a.from) : `${a.from} to ${a.to}`) : '', avatar: a.pic,
      active: (filters.artist || '').toLowerCase() === a.name.toLowerCase(), onclick: () => setFilter('artist', a.name),
    })), { numbered: true }), rankButtons));
    cards.push(card('Biggest albums', hbars(data.albums.map((a) => ({
      name: a.name, value: a.tracks, label: `${num(a.tracks)} ${a.tracks === 1 ? 'track' : 'tracks'}`, sub: [a.artist, a.from].filter(Boolean).join(', '), cover: a.cover,
      title: span(a.seconds), active: (filters.album || '').toLowerCase() === a.name.toLowerCase(), onclick: () => setFilter('album', a.name),
    })), { numbered: true, empty: 'No album names in the tags.' })));

    const formats = (card('Formats and quality', el('div', {},
      hbars(data.formats.map((f) => ({ name: f.name, value: f.tracks, label: num(f.tracks), sub: bytes(f.bytes), active: filters.format === f.name, onclick: () => setFilter('format', f.name) }))),
      data.bitrates.length ? el('h3', { text: 'Bitrate' }) : null,
      data.bitrates.length ? hbars(data.bitrates.map((b) => ({ name: b.name, value: b.tracks, label: num(b.tracks) }))) : null)));
    cards.splice(2, 0, formats);

    const longest = card('Longest tracks', hbars(data.longest.map((x) => ({
      name: x.title, value: x.seconds, label: clock(x.seconds), sub: x.artist || '', title: [x.artist, x.album].filter(Boolean).join(' · '),
    })), { numbered: true }));
    cards.push(longest);

    cards.push(card('Track lengths', el('div', {},
      vbars(data.lengths.map((l) => ({ name: l.name.replace(' min', ''), value: l.tracks, title: `${l.name}: ${num(l.tracks)} tracks` }))),
      el('div', { class: 'small muted center', text: 'minutes' }),
      data.shortest.length ? el('h3', { text: 'Shortest tracks' }) : null,
      data.shortest.length ? hbars(data.shortest.map((x) => ({ name: x.title, value: x.seconds, label: clock(x.seconds), sub: x.artist || '', title: [x.artist, x.album].filter(Boolean).join(' · ') })), { numbered: true }) : null)));
    cards.push(card('Artists A to Z', vbars(data.letters.map((l) => ({
      name: l.name, value: l.artists, title: `${l.name}: ${num(l.artists)} ${l.artists === 1 ? 'artist' : 'artists'}`,
      active: filters.letter === l.name, onclick: l.artists ? () => setFilter('letter', l.name) : null,
    })), { thin: true, labels: true })));
    cards.push(card('Added to your collection', vbars(data.added.map((y) => ({
      name: String(y.name), value: y.tracks, title: `${y.name}: ${num(y.tracks)} tracks added (by file date)`,
    }))), null));

    cards.push(card('Recently added', data.recent.albums.length ? el('div', {},
      el('p', { class: 'small muted', text: `${num(data.recent.tracks)} ${data.recent.tracks === 1 ? 'track' : 'tracks'} in the last 30 days` }),
      el('ol', { class: 'recent' }, data.recent.albums.map((a) => el('li', {},
        el('button', { type: 'button', class: 'hbar', onclick: a.album ? () => setFilter('album', a.album) : null, disabled: a.album ? null : 'disabled' },
          el('span', { class: 'hname' }, coverImg(a.cover, a.name), a.name, a.artist ? el('small', { text: a.artist }) : null),
          el('span', { class: 'hval', text: `${num(a.tracks)} · ${new Date(a.added).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` }))))))
      : empty('Nothing added in the last 30 days.')));

    if (data.collections.length > 1 && !filters.collection) {
      cards.push(card('Collections', hbars(data.collections.map((c) => ({
        name: c.name.includes('/') ? c.name.slice(c.name.indexOf('/') + 1) : c.name, value: c.tracks, label: num(c.tracks), sub: span(c.seconds), onclick: () => { $('collection').value = c.name; filters.collection = c.name; refresh(); },
      })))));
    }


    // "Show files" on each line with a list, so it's plain the line opens (it reads "Hide" when open).
    const showButton = (label = 'Show files') => el('span', { class: 'show-btn', 'aria-hidden': 'true' }, el('span', { class: 'when-closed', text: label }), el('span', { class: 'when-open', text: 'Hide' }));
    const missingNames = { artist: 'No artist', album: 'No album', year: 'No year', genre: 'No genre', title: 'No title', cover: 'No cover art (in the file or its folder)' };
    cards.push(card('Missing tags', el('div', { class: 'missing' }, Object.entries(missingNames).map(([k, name]) => {
      const m = data.missing[k];
      const pct = t.tracks ? Math.round((m.count / t.tracks) * 1000) / 10 : 0;
      const d = el('details', { open: openMissing.has(k) ? 'open' : null, ontoggle: (e) => { if (e.target.open) openMissing.add(k); else openMissing.delete(k); } },
        el('summary', { class: m.count ? 'has-list' : null }, el('span', { text: name }), el('span', { class: m.count ? 'warn' : 'good', text: m.count ? `${num(m.count)} (${pct}%)` : 'none' }), m.count ? showButton() : null),
        m.count ? el('ul', { class: 'examples' }, m.examples.map((x) => el('li', {}, el('code', { text: `${x.collection}/${x.file}` }))),
          m.count > m.examples.length ? el('li', { class: 'muted', text: `and ${num(m.count - m.examples.length)} more` }) : null) : null);
      return d;
    }),
    (() => {
      const m = data.noArtistPicture;
      const pct = m.of ? Math.round((m.count / m.of) * 1000) / 10 : 0;
      return el('details', { open: openMissing.has('artistPic') ? 'open' : null, ontoggle: (e) => { if (e.target.open) openMissing.add('artistPic'); else openMissing.delete('artistPic'); } },
        el('summary', { class: m.count ? 'has-list' : null, title: 'An artist.jpg (or .png) in the artist\'s folder' }, el('span', { text: 'No artist picture' }),
          el('span', { class: m.count ? 'warn' : 'good', text: m.count ? `${num(m.count)} of ${num(m.of)} artists (${pct}%)` : 'none' }), m.count ? showButton('Show folders') : null),
        m.count ? el('ul', { class: 'examples' }, m.examples.map((x) => el('li', {}, `${x.artist} (${num(x.tracks)} ${x.tracks === 1 ? 'track' : 'tracks'})`, x.folder ? el('br') : null, x.folder ? el('code', { text: `${x.folder}/artist.jpg` }) : null)),
          m.count > m.examples.length ? el('li', { class: 'muted', text: `and ${num(m.count - m.examples.length)} more` }) : null) : null);
    })()), null));

    $('cards').replaceChildren(...cards);
  }

  // --- Loading ---
  async function refresh() {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    // Keep the filters in the address, so a view can be bookmarked or shared.
    history.replaceState(null, '', q.toString() ? `?${q}` : location.pathname);
    try {
      const res = await fetch(`/api/stats?${q}`, { cache: 'no-store' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `The server answered ${res.status}`);
      data = body;
      draw();
      showScan(data.scan);
    } catch (e) {
      $('scanStatus').textContent = `Couldn't load: ${e.message}`;
    }
  }

  let readingSince = null;
  // The thin bar under the top bar: a number (0-100), null while counting, undefined to hide it.
  function setBar(pct) {
    const bar = $('scanBar');
    bar.hidden = pct === undefined;
    bar.classList.toggle('counting', pct === null);
    bar.firstElementChild.style.width = pct == null ? '' : `${pct}%`;
  }
  function showScan(s) {
    $('helpHours').textContent = s.everyHours || 'never';
    clearTimeout(pollTimer);
    if (s.scanning) {
      const p = s.progress;
      if (p.phase === 'counting') {
        $('scanStatus').textContent = `Counting files... ${num(p.found)} so far`;
        setBar(null);
        readingSince = null;
      } else {
        const pct = p.found ? Math.floor((p.done / p.found) * 100) : 0;
        // Time left from how fast it has gone since reading started.
        if (!readingSince) readingSince = { at: Date.now(), done: p.done };
        const rate = (p.done - readingSince.done) / ((Date.now() - readingSince.at) / 1000);
        const left = rate > 0 && p.done - readingSince.done > 50 ? (p.found - p.done) / rate : null;
        $('scanStatus').textContent = `Scanning ${pct}% (${num(p.done)} of ${num(p.found)})${left != null ? ` · about ${left < 90 ? 'a minute' : `${Math.round(left / 60)} min`} left` : ''}`;
        setBar(pct);
      }
      $('rescan').disabled = true;
      pollTimer = setTimeout(pollScan, 1500);
      return;
    }
    readingSince = null;
    setBar(undefined);
    $('rescan').disabled = false;
    const last = s.last;
    let text = last ? `Scanned ${new Date(last.finished).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not scanned yet';
    if (last && last.offline && last.offline.length) text += ` · not found: ${last.offline.join(', ')} (kept from before)`;
    if (s.error) text += ` · ${s.error}`;
    $('scanStatus').textContent = text;
  }
  let wasScanning = false;
  async function pollScan() {
    try {
      const s = await (await fetch('/api/scan', { cache: 'no-store' })).json();
      if (s.scanning) { wasScanning = true; showScan(s); return; }
      if (wasScanning) { wasScanning = false; refresh(); return; }
      showScan(s);
    } catch { pollTimer = setTimeout(pollScan, 5000); }
  }

  // --- Top bar ---
  let typing = null;
  $('search').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { const v = $('search').value.trim(); if (v) filters.q = v; else delete filters.q; refresh(); }, 250);
  });
  $('collection').addEventListener('change', () => { if ($('collection').value) filters.collection = $('collection').value; else delete filters.collection; refresh(); });
  $('rescan').addEventListener('click', async () => {
    $('rescan').disabled = true;
    await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    wasScanning = true;
    pollScan();
  });
  const theme = $('theme');
  try { theme.value = localStorage.getItem('ms-theme') || 'auto'; } catch { theme.value = 'auto'; }
  if (!theme.value) theme.value = 'auto';
  theme.addEventListener('change', () => {
    if (theme.value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme.value;
    try { localStorage.setItem('ms-theme', theme.value); } catch { /* no storage */ }
  });
  $('helpBtn').addEventListener('click', () => $('help').showModal());
  $('aboutBtn').addEventListener('click', () => $('about').showModal());
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('signOut').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; });

  window.ms = { el, refresh, reloadAbout: () => loadAbout() }; // for settings.js

  // Filters from the address (a bookmarked view).
  for (const [k, v] of new URLSearchParams(location.search)) if (/^(library|collection|decade|year|genre|artist|album|format|letter|q)$/.test(k) && v) filters[k] = v.slice(0, 200);
  if (filters.q) $('search').value = filters.q;

  // Libraries (Library/Name collections, such as PC/Music and NAS/Music): one is shown at a time,
  // and the collection list shows that library's collections by their own names.
  let about = { collections: [], libraries: [] };
  const shortName = (c) => (c.includes('/') ? c.slice(c.indexOf('/') + 1) : c);
  function fillCollections() {
    const lib = about.libraries.length ? (filters.library || about.libraries[0]) : null;
    const list = about.collections.filter((c) => !lib || c.startsWith(`${lib}/`));
    $('collection').replaceChildren(el('option', { value: '', text: 'All collections' }), ...list.map((c) => el('option', { value: c, text: shortName(c) })));
    $('collection').hidden = list.length < 2;
    if (filters.collection && !list.includes(filters.collection)) delete filters.collection;
    $('collection').value = filters.collection || '';
  }
  $('library').addEventListener('change', () => {
    filters.library = $('library').value;
    delete filters.collection;
    fillCollections();
    refresh();
  });
  async function loadAbout() {
    try {
      about = await (await fetch('/api/about')).json();
      $('aboutVersion').textContent = `Version ${about.version}`;
      $('signOut').hidden = !about.signIn;
      if (about.libraries.length) {
        if (!about.libraries.includes(filters.library)) filters.library = about.libraries[0];
        $('library').replaceChildren(...about.libraries.map((l) => el('option', { value: l, text: l })));
        $('library').value = filters.library;
        $('library').hidden = about.libraries.length < 2;
      } else {
        delete filters.library;
        $('library').hidden = true;
      }
      fillCollections();
    } catch { /* shown by refresh */ }
  }
  loadAbout().then(refresh);
})();
