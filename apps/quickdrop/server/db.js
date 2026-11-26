import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                       -- 'upload' | 'direct'
  status TEXT NOT NULL DEFAULT 'active',    -- active | completed | expired | revoked
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  manage_hash TEXT NOT NULL,
  manifest TEXT NOT NULL,                   -- encrypted in the sender's browser
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  total_size INTEGER NOT NULL,
  uploaded_chunks INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  max_downloads INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  code_lookup TEXT UNIQUE,
  code_salt TEXT,
  code_wrapped TEXT,
  code_iterations INTEGER,
  code_expires_at INTEGER,
  code_claims INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS transfers_owner ON transfers(owner_id, created_at);
CREATE INDEX IF NOT EXISTS transfers_status ON transfers(status, expires_at);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
