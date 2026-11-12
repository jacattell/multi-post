import { PLATFORMS, LABELS, LIMITS, render, count } from '/render.js';

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder. Text is always set as text, never as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.filter((c) => c != null && c !== false));
  return el;
}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch(path, {
    ...options,
    headers: options.body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) showLogin(state.providers);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const state = {
  people: [],
  accounts: {},
  providers: [],
  images: [], // { blob, url, alt, width, height, altState }
  altText: false, // whether the server can suggest alt text
  enabled: new Set(JSON.parse(localStorage.getItem('platforms') || 'null') || PLATFORMS),
};

const draft = $('draft');
const suggest = $('suggest');

// ---------- Platform toggles ----------

function drawPlatforms() {
  $('platforms').replaceChildren(...PLATFORMS.map((p) =>
    h('label', {},
      h('input', {
        type: 'checkbox',
        checked: state.enabled.has(p),
        onchange: (e) => {
          e.target.checked ? state.enabled.add(p) : state.enabled.delete(p);
          localStorage.setItem('platforms', JSON.stringify([...state.enabled]));
          drawPreviews();
        },
      }),
      LABELS[p], ' ',
      h('span', { class: 'badge' + (state.accounts[p]?.connected ? ' on' : ''),
        title: state.accounts[p]?.connected ? 'Posts directly' : 'Not connected: opens their composer with your text' },
        state.accounts[p]?.connected ? 'direct' : 'copy'),
    )));
}

// ---------- Previews ----------

function drawPreviews() {
  const text = draft.value;
  const anyOver = [];
  $('previews').replaceChildren(...PLATFORMS.filter((p) => state.enabled.has(p)).map((p) => {
    const r = render(text, p, state.people);
    const n = count(p, r.text.trim());
    if (n > LIMITS[p]) anyOver.push(p);

    const body = h('div', { class: 'body' });
    let at = 0;
    const notes = new Map();
    for (const m of r.mentions) {
      body.append(r.text.slice(at, m.start));
      body.append(h('mark', { class: m.profile ? '' : 'plain' }, r.text.slice(m.start, m.end)));
      at = m.end;
      if (!m.person) {
        notes.set(m.name, h('li', {}, `"${m.name}" is not saved. `,
          h('button', { class: 'link', onclick: () => openResolver({ query: m.name }) }, 'Find profiles')));
      } else if (!m.profile) {
        notes.set(m.name, h('li', {}, `No ${LABELS[p]} profile for ${m.person.name}; using their name. `,
          h('button', { class: 'link', onclick: () => openResolver({ person: m.person }) }, 'Add one')));
      }
    }
    body.append(r.text.slice(at));
    if (p === 'linkedin' && r.mentions.some((m) => m.profile)) {
      notes.set('', h('li', {}, 'LinkedIn shows names as plain text. It only links a name picked inside LinkedIn itself.'));
    }
    return h('div', { class: 'preview' },
      h('header', {}, LABELS[p], h('span', { class: 'count' + (n > LIMITS[p] ? ' over' : '') }, `${n} / ${LIMITS[p]}`)),
      body,
      notes.size ? h('ul', { class: 'notes' }, ...notes.values()) : null);
  }));
  $('post').disabled = (!text.trim() && !state.images.length) || !state.enabled.size || anyOver.length > 0;
  $('status').textContent = anyOver.length ? `Too long for ${anyOver.map((p) => LABELS[p]).join(', ')}` : '';
}

// ---------- @mention suggestions ----------

let menu = { open: false, start: 0, query: '', items: [], index: 0 };

/** The "@word" being typed just before the cursor, if any. */
function mentionAtCursor() {
  const pos = draft.selectionStart;
  if (pos !== draft.selectionEnd) return null;
  const m = draft.value.slice(0, pos).match(/(?:^|[\s(])@([^\s@\[\]]{0,40})$/);
  return m ? { start: pos - m[1].length - 1, query: m[1] } : null;
}

function matches(person, q) {
  if (person.name.toLowerCase().includes(q)) return true;
  return Object.values(person.profiles).some((p) => p.handle.toLowerCase().includes(q));
}

function updateMenu() {
  const found = mentionAtCursor();
  if (!found) return closeMenu();
  const q = found.query.toLowerCase();
  const people = state.people.filter((p) => matches(p, q)).slice(0, 6);
  menu = {
    open: true,
    ...found,
    items: [...people.map((person) => ({ person })), { create: true }],
    index: 0,
  };
  drawMenu();
}

function drawMenu() {
  suggest.hidden = false;
  suggest.replaceChildren(...menu.items.map((item, i) => {
    const li = item.person
      ? h('li', { role: 'option' },
          avatarOf(item.person),
          h('span', {}, item.person.name),
          h('span', { class: 'badge' }, Object.keys(item.person.profiles).map((p) => LABELS[p]).join(' · ') || 'no profiles'))
      : h('li', { role: 'option', class: 'new' },
          menu.query ? `Find "${menu.query}" on all platforms…` : 'Find someone new…');
    li.setAttribute('aria-selected', String(i === menu.index));
    li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
    return li;
  }));
  suggest.children[menu.index]?.scrollIntoView({ block: 'nearest' });
}

function closeMenu() {
  menu.open = false;
  suggest.hidden = true;
}

function insertMention(person, start, end) {
  const token = `@[${person.name}] `;
  draft.setRangeText(token, start, end, 'end');
  draft.focus();
  onDraftChange();
}

function choose(i) {
  const item = menu.items[i];
  const { start, query } = menu;
  const end = start + 1 + query.length;
  closeMenu();
  if (item.person) return insertMention(item.person, start, end);
  openResolver({ query, onSave: (person) => insertMention(person, start, end) });
}

draft.addEventListener('keydown', (e) => {
  if (!menu.open) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = menu.items.length;
    menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    drawMenu();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    choose(menu.index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
  }
});

function onDraftChange() {
  localStorage.setItem('draft', draft.value);
  drawPreviews();
}
draft.addEventListener('input', () => { onDraftChange(); updateMenu(); });
draft.addEventListener('click', updateMenu);
draft.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMenu();
});
draft.addEventListener('blur', closeMenu);

// ---------- People list ----------

function avatarOf(person) {
  const src = Object.values(person.profiles).find((p) => p.avatar)?.avatar;
  return src
    ? h('img', { class: 'avatar', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : h('span', { class: 'avatar' });
}

function shownHandle(platform, profile) {
  return platform === 'linkedin' ? `in/${profile.handle}` : `@${profile.handle}`;
}

function drawPeople() {
  if (!state.people.length) {
    return $('people').replaceChildren(h('li', { class: 'empty' }, 'Nobody yet. Type @ in a post, or use "Add person".'));
  }
  $('people').replaceChildren(...state.people.map((person) =>
    h('li', {},
      avatarOf(person),
      h('span', { class: 'name' }, person.name),
      h('span', { class: 'handles' }, ...PLATFORMS.filter((p) => person.profiles[p]).map((p) => {
        const profile = person.profiles[p];
        const label = `${LABELS[p]}: ${shownHandle(p, profile)}`;
        return profile.url ? h('a', { href: profile.url, target: '_blank', rel: 'noopener noreferrer' }, label) : h('span', {}, label);
      })),
      h('button', { onclick: () => insertMention(person, draft.selectionStart, draft.selectionEnd) }, 'Mention'),
      h('button', { onclick: () => openResolver({ person }) }, 'Edit'),
      h('button', { onclick: () => removePerson(person) }, 'Delete'),
    )));
}

async function removePerson(person) {
  if (!confirm(`Delete ${person.name} and their saved profiles?`)) return;
  await api(`/api/people/${person.id}`, { method: 'DELETE', body: '{}' });
  await loadPeople();
}

async function loadPeople() {
  state.people = await api('/api/people');
  drawPeople();
  drawPreviews();
}

$('add-person').addEventListener('click', () => openResolver({}));

// ---------- Resolver dialog: find someone's profile on each platform ----------

const SEARCH = {
  bluesky: { placeholder: 'Name or handle', site: (q) => `https://bsky.app/search?q=${encodeURIComponent(q)}`,
    empty: 'No matches. Try their handle.' },
  mastodon: { placeholder: 'Name or user@server', site: null,
    empty: 'No matches. Try their full address, like user@server.social.' },
  x: { placeholder: '@handle or x.com link', site: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=user`,
    empty: 'Enter their exact handle. Use "Find on X" to look it up.' },
  linkedin: { placeholder: 'Paste profile link (linkedin.com/in/…)', site: (q) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`,
    empty: 'LinkedIn has no public lookup. Use "Find on LinkedIn", then paste the profile link here.' },
};

const dialog = $('resolver');
let resolver = null;

function openResolver({ query = '', person = null, onSave = null }) {
  resolver = { person, onSave, selected: { ...(person?.profiles || {}) }, draw: {} };
  $('resolver-title').textContent = person ? `Edit ${person.name}` : 'Find profiles';
  $('resolver-error').textContent = '';
  const nameInput = $('person-name');
  nameInput.value = person?.name || query;

  $('resolver-platforms').replaceChildren(...PLATFORMS.map((p) => {
    const cfg = SEARCH[p];
    const existing = person?.profiles[p];
    const seed = person ? person.name : query;
    const input = h('input', {
      placeholder: cfg.placeholder, 'aria-label': `${LABELS[p]} search`, autocomplete: 'off',
      // LinkedIn needs a link, so a name is no use as a starting value.
      value: existing ? (p === 'linkedin' ? existing.url || '' : existing.handle) : (p === 'linkedin' ? '' : seed),
    });
    const list = h('ul', { class: 'cands' });
    const msg = h('p', { class: 'msg' });
    const siteLink = cfg.site && h('a', { target: '_blank', rel: 'noopener noreferrer' }, `Find on ${LABELS[p]} ↗`);
    const setSiteLink = () => { if (siteLink) siteLink.href = cfg.site(nameInput.value.trim() || input.value.trim()); };
    setSiteLink();
    nameInput.addEventListener('input', setSiteLink);

    let results = [];
    let seq = 0;
    const draw = () => {
      const sel = resolver.selected[p];
      const shown = sel && !results.some((c) => c.handle === sel.handle) ? [sel, ...results] : results;
      list.replaceChildren(...shown.map((c) => {
        const on = sel?.handle === c.handle;
        return h('li', { class: 'cand-row' },
          h('button', {
            type: 'button', class: 'cand', 'aria-pressed': String(on),
            onclick: () => { on ? delete resolver.selected[p] : (resolver.selected[p] = c); draw(); },
          },
            c.avatar ? h('img', { class: 'avatar', src: c.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }),
            h('span', { class: 'who' },
              h('span', {}, c.displayName || shownHandle(p, c)),
              h('span', { class: 'h' }, shownHandle(p, c) + (c.unverified ? ' · not checked' : ''))),
          ),
          c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open profile' }, 'View ↗') : null);
      }));
    };
    const search = async () => {
      const q = input.value.trim();
      const mine = ++seq;
      setSiteLink();
      if (!q) { results = []; msg.textContent = cfg.empty; return draw(); }
      msg.textContent = 'Searching…';
      try {
        const found = await api(`/api/resolve/${p}?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        results = found;
        msg.textContent = found.length ? '' : cfg.empty;
      } catch (err) {
        if (mine !== seq) return;
        results = [];
        msg.textContent = err.message;
      }
      draw();
    };
    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); } });
    search();

    return h('div', { class: 'plat' }, h('h3', {}, LABELS[p], siteLink || null), input, list, msg);
  }));

  dialog.showModal();
  nameInput.focus();
}

$('resolver-cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { resolver = null; draft.focus(); });

$('resolver-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { person, onSave, selected } = resolver;
  const body = JSON.stringify({ name: $('person-name').value, profiles: selected });
  $('resolver-save').disabled = true;
  try {
    const saved = person
      ? await api(`/api/people/${person.id}`, { method: 'PUT', body })
      : await api('/api/people', { method: 'POST', body });
    // Keep existing drafts pointing at the person if they were renamed.
    if (person && person.name !== saved.name) {
      draft.value = draft.value.replaceAll(`@[${person.name}]`, `@[${saved.name}]`);
      localStorage.setItem('draft', draft.value);
    }
    dialog.close();
    await loadPeople();
    onSave?.(saved);
  } catch (err) {
    $('resolver-error').textContent = err.message;
  } finally {
    $('resolver-save').disabled = false;
  }
});

// ---------- Images ----------

const MAX_IMAGES = 4;
const MAX_BYTES = 950_000; // Bluesky allows about 1 MB per image
const KEEP_TYPES = ['image/jpeg', 'image/png', 'image/gif'];

/** Returns the file as it is when small enough, otherwise a smaller JPEG. */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  if (KEEP_TYPES.includes(file.type) && file.size <= MAX_BYTES) return { blob: file, width, height };

  let scale = Math.min(1, 2048 / Math.max(width, height));
  let quality = 0.9;
  for (let attempt = 0; attempt < 12; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // JPEG has no transparency
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_BYTES) return { blob, width: canvas.width, height: canvas.height };
    if (quality > 0.65) quality -= 0.1; else scale *= 0.8;
  }
  throw new Error('could not be made small enough');
}

async function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (state.images.length >= MAX_IMAGES) {
      $('status').textContent = `At most ${MAX_IMAGES} images`;
      break;
    }
    try {
      const prepared = await prepareImage(file);
      const img = { ...prepared, url: URL.createObjectURL(prepared.blob), alt: '', altState: null };
      state.images.push(img);
      if (state.altText) suggestAlt(img);
    } catch (err) {
      $('status').textContent = `${file.name}: ${err.message || 'not a usable image'}`;
    }
  }
  drawImages();
}

const ALT_NOTES = {
  writing: 'Writing a description…',
  suggested: 'Suggested automatically. Check it’s right.',
  failed: 'Could not suggest a description. Please write one.',
};

/** Asks the server to suggest alt text. Never replaces anything typed in the meantime. */
async function suggestAlt(img) {
  img.altState = 'writing';
  showAltState(img);
  const form = new FormData();
  form.append('image', img.blob);
  form.append('text', draft.value);
  try {
    const { alt } = await api('/api/alt-text', { method: 'POST', body: form });
    if (!state.images.includes(img) || img.alt.trim()) { img.altState = null; return; }
    img.alt = alt;
    img.altState = 'suggested';
    if (img.input) img.input.value = alt;
    drawPreviews();
  } catch {
    if (state.images.includes(img) && !img.alt.trim()) img.altState = 'failed';
    else img.altState = null;
  }
  showAltState(img);
}

/** Updates one image's description box and note without redrawing the list (keeps your cursor where it is). */
function showAltState(img) {
  if (!img.input) return;
  img.input.placeholder = img.altState === 'writing' ? ALT_NOTES.writing : 'Describe this image (alt text)';
  img.input.setAttribute('aria-busy', String(img.altState === 'writing'));
  img.note.textContent = ALT_NOTES[img.altState] || '';
}

function drawImages() {
  $('images').replaceChildren(...state.images.map((img, i) => {
    img.input = h('input', {
      placeholder: 'Describe this image (alt text)', 'aria-label': `Description of image ${i + 1}`,
      'aria-describedby': `alt-note-${i}`,
      value: img.alt, maxlength: 1000, oninput: (e) => {
        img.alt = e.target.value;
        if (img.altState) { img.altState = null; showAltState(img); }
      },
    });
    img.note = h('span', { class: 'alt-note', id: `alt-note-${i}`, 'aria-live': 'polite' });
    showAltState(img);
    return h('li', {},
      h('img', { src: img.url, alt: img.alt || `Image ${i + 1}` }),
      h('div', { class: 'alt-field' }, img.input, img.note),
      h('button', { 'aria-label': `Remove image ${i + 1}`, onclick: () => {
        URL.revokeObjectURL(img.url);
        state.images.splice(i, 1);
        drawImages();
      } }, 'Remove'));
  }));
  $('add-image').disabled = state.images.length >= MAX_IMAGES;
  drawPreviews();
}

$('add-image').addEventListener('click', () => $('image-input').click());
$('image-input').addEventListener('change', (e) => { addImages([...e.target.files]); e.target.value = ''; });
draft.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addImages(files); }
});
$('composer').addEventListener('dragover', (e) => e.preventDefault());
$('composer').addEventListener('drop', (e) => { e.preventDefault(); addImages([...e.dataTransfer.files]); });

// ---------- Posting ----------

$('post').addEventListener('click', async () => {
  const button = $('post');
  button.disabled = true;
  $('status').textContent = 'Posting…';
  $('results').replaceChildren();
  const hasImages = state.images.length > 0;
  const form = new FormData();
  form.set('text', draft.value);
  form.set('platforms', JSON.stringify([...state.enabled]));
  form.set('imageMeta', JSON.stringify(state.images.map(({ alt, width, height }) => ({ alt, width, height }))));
  for (const img of state.images) form.append('images', img.blob, 'image');
  try {
    const results = await api('/api/post', { method: 'POST', body: form });
    $('status').textContent = '';
    $('results').replaceChildren(...Object.entries(results).map(([p, r]) => {
      const copyAndOpen = h('a', {
        href: r.url, target: '_blank', rel: 'noopener noreferrer',
        onclick: () => navigator.clipboard?.writeText(r.text).catch(() => {}),
      }, `Copy text and open ${LABELS[p]} ↗`);
      const addByHand = hasImages ? h('span', { class: 'hint-inline' }, 'Add the images there by hand.') : null;
      if (r.status === 'posted') {
        return h('div', { class: 'result' }, h('strong', {}, LABELS[p]), h('span', { class: 'posted' }, 'Posted'),
          h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'View post ↗'));
      }
      if (r.status === 'error') {
        return h('div', { class: 'result' }, h('strong', {}, LABELS[p]), h('span', { class: 'failed' }, `Failed: ${r.error}`), copyAndOpen, addByHand);
      }
      return h('div', { class: 'result' }, h('strong', {}, LABELS[p]), h('span', {}, 'Not connected.'), copyAndOpen, addByHand);
    }));
  } catch (err) {
    $('status').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('clear').addEventListener('click', () => {
  if ((draft.value.trim() || state.images.length) && !confirm('Clear the text and images?')) return;
  draft.value = '';
  state.images.forEach((img) => URL.revokeObjectURL(img.url));
  state.images = [];
  $('results').replaceChildren();
  drawImages();
  onDraftChange();
  draft.focus();
});

// ---------- Your accounts ----------

const ACCOUNT_FORMS = {
  bluesky: {
    intro: 'Use an app password, not your main password. Create one in Bluesky under Settings → Privacy and security → App passwords.',
    fields: [
      { name: 'handle', label: 'Handle', placeholder: 'you.bsky.social' },
      { name: 'appPassword', label: 'App password', placeholder: 'xxxx-xxxx-xxxx-xxxx', type: 'password' },
    ],
  },
  mastodon: {
    intro: 'On your server, go to Preferences → Development → New application. Tick write:statuses, write:media and read:search, then copy the access token.',
    fields: [
      { name: 'instance', label: 'Server', placeholder: 'mastodon.social' },
      { name: 'token', label: 'Access token', type: 'password' },
    ],
  },
};

function drawAccounts() {
  $('accounts').replaceChildren(...PLATFORMS.map((p) => {
    const a = state.accounts[p] || {};
    const daysLeft = a.expiresAt ? Math.floor((a.expiresAt - Date.now()) / 86400_000) : null;
    let status = a.connected ? `Connected as ${a.label}` : 'Not connected';
    if (a.connected && daysLeft !== null) status += daysLeft < 0 ? ' (expired, reconnect)' : ` (reconnect within ${daysLeft} days)`;
    if (!a.connected && !a.canConnect) status = 'Needs setup first. See the README.';

    const connect = ACCOUNT_FORMS[p]
      ? h('button', { onclick: () => openAccountForm(p) }, a.connected ? 'Change' : 'Connect')
      : a.canConnect ? h('a', { class: 'button', href: `/api/connect/${p}` }, a.connected ? 'Reconnect' : 'Connect') : null;
    const disconnect = a.connected && h('button', { onclick: async () => {
      if (!confirm(`Disconnect ${LABELS[p]}?`)) return;
      await api(`/api/accounts/${p}`, { method: 'DELETE', body: '{}' });
      await loadConfig();
    } }, 'Disconnect');

    return h('li', {},
      h('span', { class: 'name' }, LABELS[p]),
      h('span', { class: 'handles' + (a.connected ? ' ok' : '') }, status),
      connect, disconnect || null);
  }));
}

const accountDialog = $('account-dialog');
let accountPlatform = null;

function openAccountForm(platform) {
  const cfg = ACCOUNT_FORMS[platform];
  accountPlatform = platform;
  $('account-title').textContent = `Connect ${LABELS[platform]}`;
  $('account-intro').textContent = cfg.intro;
  $('account-error').textContent = '';
  $('account-fields').replaceChildren(...cfg.fields.map((f) =>
    h('label', { class: 'field' }, f.label,
      h('input', { name: f.name, type: f.type || 'text', placeholder: f.placeholder, required: true, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }))));
  accountDialog.showModal();
}

$('account-cancel').addEventListener('click', () => accountDialog.close());
$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('account-save').disabled = true;
  try {
    await api(`/api/accounts/${accountPlatform}`, { method: 'POST', body: JSON.stringify(body) });
    accountDialog.close();
    await loadConfig();
  } catch (err) {
    $('account-error').textContent = err.message;
  } finally {
    $('account-save').disabled = false;
  }
});

async function loadConfig() {
  const config = await api('/api/config');
  state.accounts = config.accounts;
  state.altText = Boolean(config.altText);
  drawPlatforms();
  drawAccounts();
}

// ---------- Login ----------

const PROVIDER_LABELS = { google: 'Google', github: 'GitHub' };

function showLogin(providers) {
  $('app').hidden = true;
  $('logout').hidden = true;
  $('me').textContent = '';
  $('login').hidden = false;
  if (providers) {
    $('login-buttons').replaceChildren(...providers.map((p) =>
      h('a', { class: 'button', href: `/api/login/${p}` }, `Continue with ${PROVIDER_LABELS[p] || p}`)));
  }
}

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  location.assign('/');
});

// ---------- Start ----------

async function start() {
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    showLogin();
    $('login-error').textContent = err.message;
    return;
  }
  state.providers = me.providers || [];
  const params = new URLSearchParams(location.search);
  if (params.size) history.replaceState(null, '', '/');
  if (!me.loggedIn) {
    showLogin(me.providers);
    $('login-error').textContent = params.get('login_error') || '';
    return;
  }
  $('me').textContent = me.email;
  $('login').hidden = true;
  $('app').hidden = false;
  $('logout').hidden = false;
  draft.value = localStorage.getItem('draft') || '';
  await loadConfig();
  await loadPeople();
  drawImages();

  // Message left by the "Connect X / LinkedIn" round trip.
  if (params.has('connected')) $('accounts-status').textContent = `${LABELS[params.get('connected')] || 'Account'} connected.`;
  if (params.has('connect_error')) $('accounts-status').textContent = `Could not connect. ${params.get('connect_error')}`;
}

await start();
