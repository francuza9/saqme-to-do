// The database migrations, for the Worker to apply by itself (src/schema.js): the same SQL as worker/migrations/*.sql,
// which stay the readable source (and what wrangler and the Linux/macOS app read). A Worker cannot read files, so
// they are repeated here; worker/test/node/schema.test.js fails when the two differ in any statement.
// A new migration: add worker/migrations/NNNN_name.sql, then the same SQL here, under the same file name.
export const MIGRATIONS = [
  { name: '0001_init.sql', sql: `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', '0');
INSERT OR IGNORE INTO meta (key, value) VALUES ('db_id', lower(hex(randomblob(8))));
INSERT OR IGNORE INTO meta (key, value) VALUES ('lock', '1');

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL DEFAULT '',
  name_ts     INTEGER NOT NULL DEFAULT 0,
  position    TEXT    NOT NULL DEFAULT 'a0',
  position_ts INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  deleted_ts  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS projects_seq ON projects (seq);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT    NOT NULL,
  parent_id   TEXT,
  position    TEXT    NOT NULL DEFAULT 'a0',
  place_ts    INTEGER NOT NULL DEFAULT 0,
  text        TEXT    NOT NULL DEFAULT '',
  text_ts     INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT ' ',
  status_ts   INTEGER NOT NULL DEFAULT 0,
  due         TEXT,
  due_time    TEXT    NOT NULL DEFAULT '',
  due_ts      INTEGER NOT NULL DEFAULT 0,
  notes       TEXT    NOT NULL DEFAULT '',
  notes_ts    INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  deleted_ts  INTEGER NOT NULL DEFAULT 0,
  devs        TEXT    NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_seq ON tasks (seq);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks (due) WHERE due IS NOT NULL AND deleted = 0;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT    NOT NULL DEFAULT '',
  ts    INTEGER NOT NULL DEFAULT 0,
  seq   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS settings_seq ON settings (seq);

CREATE TABLE IF NOT EXISTS conflicts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT    NOT NULL,
  field       TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  value_ts    INTEGER NOT NULL,
  other       TEXT    NOT NULL,
  device_id   TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  resolved_ts INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS conflicts_seq ON conflicts (seq);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  device_id  TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_ok    INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notified (
  key TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);
` },
  { name: '0002_shares.sql', sql: `
CREATE TABLE IF NOT EXISTS shares (
  id                TEXT PRIMARY KEY,
  project_id        TEXT    NOT NULL,
  alias             TEXT    NOT NULL DEFAULT '',
  access            TEXT    NOT NULL DEFAULT 'view' CHECK (access IN ('edit', 'view')),
  token_hash        TEXT,
  invite_code_hash  TEXT,
  invite_expires_at INTEGER NOT NULL DEFAULT 0,
  claimed_at        INTEGER,
  revoked_at        INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shares_token ON shares (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shares_invite ON shares (invite_code_hash) WHERE invite_code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS shares_project ON shares (project_id);

CREATE TABLE IF NOT EXISTS moved_out (
  project_id TEXT    NOT NULL,
  task_id    TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS moved_out_seq ON moved_out (project_id, seq);

CREATE INDEX IF NOT EXISTS tasks_project_seq ON tasks (project_id, seq);
` },
  { name: '0003_remotes.sql', sql: `
ALTER TABLE shares ADD COLUMN old_token_hash TEXT;
ALTER TABLE shares ADD COLUMN transferred_at INTEGER;
ALTER TABLE shares ADD COLUMN relayed_at INTEGER;
CREATE INDEX IF NOT EXISTS shares_old_token ON shares (old_token_hash) WHERE old_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS share_push (
  share_id   TEXT    NOT NULL,
  endpoint   TEXT    NOT NULL,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  tz         TEXT    NOT NULL DEFAULT 'UTC',
  notify_at  TEXT    NOT NULL DEFAULT '10:00',
  created_at INTEGER NOT NULL,
  failures   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, endpoint)
);

CREATE TABLE IF NOT EXISTS remotes (
  id          TEXT PRIMARY KEY,
  server      TEXT    NOT NULL,
  token       TEXT    NOT NULL,
  project_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  access      TEXT    NOT NULL DEFAULT 'view',
  state       TEXT    NOT NULL DEFAULT 'active',
  converted   INTEGER NOT NULL DEFAULT 0,
  project_deleted INTEGER NOT NULL DEFAULT 0,
  cursor      INTEGER NOT NULL DEFAULT 0,
  polled_at   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS remotes_active ON remotes (server, project_id) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS remote_tasks (
  remote_id TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  text      TEXT    NOT NULL DEFAULT '',
  status    TEXT    NOT NULL DEFAULT ' ',
  due       TEXT,
  due_time  TEXT    NOT NULL DEFAULT '',
  deleted   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (remote_id, id)
);
` },
  { name: '0004_connector.sql', sql: `
CREATE TABLE IF NOT EXISTS connector (
  id           TEXT PRIMARY KEY,
  nonce        TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  window_calls INTEGER NOT NULL DEFAULT 0,
  delete_start INTEGER NOT NULL DEFAULT 0,
  delete_count INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO connector (id, nonce, created_at) VALUES ('main', lower(hex(randomblob(16))), CAST(strftime('%s', 'now') AS INTEGER) * 1000);
` },
];
