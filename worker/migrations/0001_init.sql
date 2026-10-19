-- Saqme To Do: initial schema.
-- Every syncable row carries per-field timestamps (*_ts, client ms clocks clamped by the server)
-- and `seq`, the server change sequence at which the row last changed (clients sync "since cursor").

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 'seq' = last assigned change sequence; 'db_id' lets clients notice a recreated database.
-- 'lock' never changes: the sync writer inserts it again on purpose to abort a stale batch.
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
  place_ts    INTEGER NOT NULL DEFAULT 0,   -- project_id + parent_id + position move together
  text        TEXT    NOT NULL DEFAULT '',
  text_ts     INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT ' ',
  status_ts   INTEGER NOT NULL DEFAULT 0,
  due         TEXT,                         -- YYYY-MM-DD or NULL
  due_time    TEXT    NOT NULL DEFAULT '',  -- H:MM or ''
  due_ts      INTEGER NOT NULL DEFAULT 0,
  notes       TEXT    NOT NULL DEFAULT '',
  notes_ts    INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,   -- tombstone, never hard-deleted
  deleted_ts  INTEGER NOT NULL DEFAULT 0,
  devs        TEXT    NOT NULL DEFAULT '{}', -- JSON {field: device id of its last writer}
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

-- Losing values of concurrent edits, surfaced in every client until resolved.
CREATE TABLE IF NOT EXISTS conflicts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT    NOT NULL,
  field       TEXT    NOT NULL,               -- text | status | due | notes | deleted
  value       TEXT    NOT NULL,               -- JSON of the losing value
  value_ts    INTEGER NOT NULL,
  other       TEXT    NOT NULL,               -- JSON of the value that won
  device_id   TEXT    NOT NULL DEFAULT '',    -- device whose sync detected the conflict
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

-- Reminder dedupe keys ("2026-10-25|soon|<task id>|14:00", "2026-10-25|digest"), pruned after a week.
CREATE TABLE IF NOT EXISTS notified (
  key TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);
