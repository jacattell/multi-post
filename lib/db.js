import { DatabaseSync } from 'node:sqlite';
import { PLATFORMS } from './render.js';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS profiles (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      display_name TEXT,
      avatar TEXT,
      url TEXT,
      platform_id TEXT,
      PRIMARY KEY (person_id, platform)
    );
  `);
  return db;
}

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

export function listPeople(db) {
  const people = db.prepare('SELECT id, name FROM people ORDER BY name').all()
    .map((p) => ({ ...p, profiles: {} }));
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const r of db.prepare('SELECT * FROM profiles').all()) {
    byId.get(r.person_id).profiles[r.platform] = {
      handle: r.handle,
      displayName: r.display_name,
      avatar: r.avatar,
      url: r.url,
      platformId: r.platform_id,
    };
  }
  return people;
}

export function getPerson(db, id) {
  return listPeople(db).find((p) => p.id === id) || null;
}

/** Create (no id) or replace (id) a person and all their profiles. */
export function savePerson(db, { id, name, profiles }) {
  const cleanedName = cleanName(name);
  const cleaned = cleanProfiles(profiles);
  db.exec('BEGIN');
  try {
    if (id) {
      const res = db.prepare('UPDATE people SET name = ? WHERE id = ?').run(cleanedName, id);
      if (!res.changes) throw new ValidationError('Person not found');
      db.prepare('DELETE FROM profiles WHERE person_id = ?').run(id);
    } else {
      id = Number(db.prepare('INSERT INTO people (name) VALUES (?)').run(cleanedName).lastInsertRowid);
    }
    const insert = db.prepare(
      'INSERT INTO profiles (person_id, platform, handle, display_name, avatar, url, platform_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [platform, p] of Object.entries(cleaned)) {
      insert.run(id, platform, p.handle, p.displayName, p.avatar, p.url, p.platformId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (/UNIQUE constraint failed: people\.name/.test(err.message)) {
      throw new ValidationError(`"${cleanedName}" is already saved`);
    }
    throw err;
  }
  return getPerson(db, id);
}

export function deletePerson(db, id) {
  return db.prepare('DELETE FROM people WHERE id = ?').run(id).changes > 0;
}
