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

-- Your connected social accounts. "data" is encrypted JSON.
CREATE TABLE IF NOT EXISTS accounts (
  platform TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Short-lived records for the "Connect X / LinkedIn" redirects.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  verifier TEXT,
  created_at INTEGER NOT NULL
);

-- Failed logins, used to slow down password guessing.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts (ip, at);
