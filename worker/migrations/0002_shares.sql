-- Saqme To Do: shared lists (docs/sync.md, "Shared lists").
-- One row per person a project is shared with. Only SHA-256 digests are stored: of the one-time invite code
-- (until it is claimed) and of the person's token (from then on). Rows are never deleted: revoking sets
-- revoked_at, and the token stops working at once.
CREATE TABLE IF NOT EXISTS shares (
  id                TEXT PRIMARY KEY,                -- random; the owner's apps use it to change or revoke
  project_id        TEXT    NOT NULL,
  alias             TEXT    NOT NULL DEFAULT '',     -- the owner's name for the person ("Nuca"), never sent to them
  access            TEXT    NOT NULL DEFAULT 'view' CHECK (access IN ('edit', 'view')),
  token_hash        TEXT,                            -- hex SHA-256 of the person's token, set by the claim
  invite_code_hash  TEXT,                            -- hex SHA-256 of the invite code, cleared by the claim
  invite_expires_at INTEGER NOT NULL DEFAULT 0,
  claimed_at        INTEGER,
  revoked_at        INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shares_token ON shares (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shares_invite ON shares (invite_code_hash) WHERE invite_code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS shares_project ON shares (project_id);

-- A task that moved to another project: whoever the old project is shared with must be told it left, but its
-- row now belongs to a project they cannot see. They get just "this id is gone" (src/sync.js).
CREATE TABLE IF NOT EXISTS moved_out (
  project_id TEXT    NOT NULL,
  task_id    TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS moved_out_seq ON moved_out (project_id, seq);

-- a shared list's sync reads one project's tasks
CREATE INDEX IF NOT EXISTS tasks_project_seq ON tasks (project_id, seq);
