// Settings: pick the music folders to read, with a folder browser.
(() => {
  const $ = (id) => document.getElementById(id);
  const { el } = window.ms;
  let current = { collections: [], root: '/music', fromSettings: false };
  let here = '';

  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`);
    return data;
  }
  function say(text, good) {
    $('fResult').textContent = text;
    $('fResult').className = `small ${good === true ? 'good' : good === false ? 'bad' : 'muted'}`;
  }

  async function load() {
    current = await call('GET', '/api/settings');
    $('musicRoot').textContent = current.root;
    drawList();
  }

  function drawList() {
    const list = current.collections;
    $('fromEnv').hidden = current.fromSettings || !list.length;
    $('libraryNames').replaceChildren(...[...new Set(list.map((c) => c.library).filter(Boolean))].map((l) => el('option', { value: l })));
    if (!list.length) { $('folderList').replaceChildren(el('p', { class: 'muted', text: 'No music folders yet: add one below.' })); return; }
    $('folderList').replaceChildren(el('table', { class: 'settings-table' }, el('tbody', {}, list.map((c, i) => el('tr', {},
      el('td', { class: 'name' }, c.library ? el('span', { class: 'lib', text: c.library }) : null, c.name),
      el('td', {}, el('code', { text: c.folder != null ? `${current.root}/${c.folder}`.replace(/\/$/, '') : c.dir })),
      el('td', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: 'Remove', onclick: () => remove(i) })))))));
  }

  async function saveList(list) {
    const r = await call('PUT', '/api/settings/collections', { collections: list.map((c) => ({ name: c.name, library: c.library, folder: c.folder })) });
    current.collections = r.collections;
    current.fromSettings = true;
    drawList();
    await window.ms.reloadAbout();
    window.ms.refresh();
  }
  async function remove(i) {
    const c = current.collections[i];
    if (!window.confirm(`Stop reading ${c.library ? `${c.library} ` : ''}${c.name}? Its tracks leave the numbers after the rescan. The folder itself isn't touched.`)) return;
    try { await saveList(current.collections.filter((_, j) => j !== i && current.collections[j].folder != null)); } catch (e) { window.alert(e.message); }
  }

  // --- Folder browser ---
  async function browse(rel) {
    $('picker').replaceChildren(el('li', { class: 'muted small', text: 'Opening...' }));
    try {
      const r = await call('GET', `/api/folders?path=${encodeURIComponent(rel)}`);
      here = r.path;
      const parts = here ? here.split('/') : [];
      $('crumbs').replaceChildren(
        el('button', { type: 'button', class: 'crumb', text: 'Music folders', title: r.root, onclick: () => browse('') }),
        ...parts.flatMap((p, i) => [el('span', { class: 'muted', text: ' / ' }), el('button', { type: 'button', class: 'crumb', text: p, onclick: () => browse(parts.slice(0, i + 1).join('/')) })]));
      $('picker').replaceChildren(...(r.folders.length ? r.folders.map((f) => el('li', {},
        el('button', { type: 'button', class: 'folder', onclick: () => browse(here ? `${here}/${f}` : f) }, el('span', { 'aria-hidden': 'true', text: '📁 ' }), f)))
        : [el('li', { class: 'muted small', text: 'No folders inside this one.' })]));
      if (!$('fName').dataset.typed) $('fName').value = parts.length ? parts[parts.length - 1] : '';
      // When the folders already have libraries, suggest the top folder (such as PC or NAS) as this one's.
      if (!$('fLibrary').dataset.typed && current.collections.some((c) => c.library)) $('fLibrary').value = parts.length > 1 ? parts[0] : '';
      say(here ? `Chosen: ${r.root}/${here}` : `Chosen: ${r.root} (all of it)`);
    } catch (e) { $('picker').replaceChildren(el('li', { class: 'bad small', text: e.message })); }
  }
  $('fName').addEventListener('input', () => { $('fName').dataset.typed = $('fName').value ? '1' : ''; });
  $('fLibrary').addEventListener('input', () => { $('fLibrary').dataset.typed = $('fLibrary').value ? '1' : ''; });

  $('fAdd').addEventListener('click', async () => {
    const name = $('fName').value.trim();
    if (!name) { say('Give it a name first.', false); return; }
    const library = $('fLibrary').value.trim();
    const libs = current.collections.filter((c) => c.folder != null);
    if (libs.length && (!!library) !== libs.some((c) => c.library)) {
      say(library ? 'The folders already added have no library. Give them one too, or leave this blank.' : 'The folders already added have a library: give this one a library too.', false);
      return;
    }
    try {
      await saveList([...libs, { name, library, folder: here }]);
      say(`${library ? `${library} ` : ''}${name} added. Reading it now.`, true);
      $('fName').value = ''; $('fName').dataset.typed = ''; $('fLibrary').dataset.typed = '';
    } catch (e) { say(e.message, false); }
  });

  $('settingsBtn').addEventListener('click', async () => {
    $('settings').showModal();
    try { await load(); } catch (e) { $('folderList').replaceChildren(el('p', { class: 'bad', text: e.message })); }
  });
  $('addFolder').addEventListener('toggle', () => { if ($('addFolder').open) browse(here); });
  if (window.location.hash === '#settings') $('settingsBtn').click();
})();
