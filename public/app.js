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
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const state = {
  people: [],
  config: { connected: {}, canVerifyX: false },
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
      h('span', { class: 'badge' + (state.config.connected[p] ? ' on' : ''),
        title: state.config.connected[p] ? 'Posts directly' : 'Opens the composer with your text' },
        state.config.connected[p] ? 'direct' : 'copy'),
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
      notes.set('', h('li', {}, 'LinkedIn only links a name when you pick it in their composer: retype @ before the name there.'));
    }
    return h('div', { class: 'preview' },
      h('header', {}, LABELS[p], h('span', { class: 'count' + (n > LIMITS[p] ? ' over' : '') }, `${n} / ${LIMITS[p]}`)),
      body,
      notes.size ? h('ul', { class: 'notes' }, ...notes.values()) : null);
  }));
  $('post').disabled = !text.trim() || !state.enabled.size || anyOver.length > 0;
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

// ---------- Posting ----------

$('post').addEventListener('click', async () => {
  const button = $('post');
  button.disabled = true;
  $('status').textContent = 'Posting…';
  $('results').replaceChildren();
  try {
    const results = await api('/api/post', {
      method: 'POST',
      body: JSON.stringify({ text: draft.value, platforms: [...state.enabled] }),
    });
    $('status').textContent = '';
    $('results').replaceChildren(...Object.entries(results).map(([p, r]) => {
      const copyAndOpen = h('a', {
        href: r.url, target: '_blank', rel: 'noopener noreferrer',
        onclick: () => navigator.clipboard?.writeText(r.text).catch(() => {}),
      }, `Copy text and open ${LABELS[p]} ↗`);
      if (r.status === 'posted') {
        return h('div', { class: 'result' }, h('strong', {}, LABELS[p]), h('span', { class: 'posted' }, 'Posted'),
          h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'View post ↗'));
      }
      if (r.status === 'error') {
        return h('div', { class: 'result' }, h('strong', {}, LABELS[p]), h('span', { class: 'failed' }, `Failed: ${r.error}`), copyAndOpen);
      }
      return h('div', { class: 'result' }, h('strong', {}, LABELS[p]), copyAndOpen);
    }));
  } catch (err) {
    $('status').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// ---------- Start ----------

draft.value = localStorage.getItem('draft') || '';
state.config = await api('/api/config');
drawPlatforms();
await loadPeople();
