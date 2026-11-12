// Saved people and their profiles. "db" is a Cloudflare D1 database.

import { PLATFORMS } from '../public/render.js';

export class ValidationError extends Error {}

const httpsOrNull = (v) => (typeof v === 'string' && /^https:\/\//.test(v) ? v.slice(0, 500) : null);
const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);

function cleanName(name) {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!n) throw new ValidationError('Name is required');
  if (n.length > 80) throw new ValidationError('Name is too long');
  if (/[\[\]]/.test(n)) throw new ValidationError('Name cannot contain [ or ]');
  return n;
}

function cleanProfiles(profiles = {}) {
  const out = {};
  for (const platform of PLATFORMS) {
    const p = profiles?.[platform];
    if (!p) continue;
    const handle = strOrNull(p.handle)?.replace(/^@/, '');
    if (!handle || /\s/.test(handle)) throw new ValidationError(`Invalid ${platform} handle`);
    out[platform] = {
      handle,
      displayName: strOrNull(p.displayName),
      avatar: httpsOrNull(p.avatar),
      url: httpsOrNull(p.url),
      platformId: strOrNull(p.platformId),
    };
  }
  return out;
}

export async function listPeople(db) {
  const [people, profiles] = await Promise.all([
    db.prepare('SELECT id, name FROM people ORDER BY name').all(),
    db.prepare('SELECT * FROM profiles').all(),
  ]);
  const out = people.results.map((p) => ({ ...p, profiles: {} }));
  const byId = new Map(out.map((p) => [p.id, p]));
  for (const r of profiles.results) {
    const person = byId.get(r.person_id);
    if (!person) continue;
    person.profiles[r.platform] = {
      handle: r.handle,
      displayName: r.display_name,
      avatar: r.avatar,
      url: r.url,
      platformId: r.platform_id,
    };
  }
  return out;
}

/** Create (no id) or replace (id) a person and all their profiles. */
export async function savePerson(db, { id, name, profiles }) {
  const cleanedName = cleanName(name);
  const cleaned = cleanProfiles(profiles);
  try {
    if (id) {
      const found = await db.prepare('SELECT id FROM people WHERE id = ?').bind(id).first();
      if (!found) throw new ValidationError('Person not found');
    } else {
      const res = await db.prepare('INSERT INTO people (name) VALUES (?)').bind(cleanedName).run();
      id = res.meta.last_row_id;
    }
    // One batch is one transaction: the profiles are swapped all at once.
    await db.batch([
      db.prepare('UPDATE people SET name = ? WHERE id = ?').bind(cleanedName, id),
      db.prepare('DELETE FROM profiles WHERE person_id = ?').bind(id),
      ...Object.entries(cleaned).map(([platform, p]) =>
        db.prepare(
          'INSERT INTO profiles (person_id, platform, handle, display_name, avatar, url, platform_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(id, platform, p.handle, p.displayName, p.avatar, p.url, p.platformId)),
    ]);
  } catch (err) {
    if (/UNIQUE constraint failed: people\.name/.test(err.message)) {
      throw new ValidationError(`"${cleanedName}" is already saved`);
    }
    throw err;
  }
  return (await listPeople(db)).find((p) => p.id === id);
}

export async function deletePerson(db, id) {
  const [, res] = await db.batch([
    db.prepare('DELETE FROM profiles WHERE person_id = ?').bind(id),
    db.prepare('DELETE FROM people WHERE id = ?').bind(id),
  ]);
  return res.meta.changes > 0;
}
