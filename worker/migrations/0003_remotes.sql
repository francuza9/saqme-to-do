-- Saqme To Do: shared lists, second step (docs/sync.md, "Shared lists").

-- The owner's side. A share can move to another of its person's apps ("Move to my Saqme app"): a one-time
-- move code re-keys it, and the key it replaced answers 401 'transferred'. relayed_at: when the key was last
-- used through its person's own Worker, which then reminds them itself (so this one stops pushing).
ALTER TABLE shares ADD COLUMN old_token_hash TEXT;
ALTER TABLE shares ADD COLUMN transferred_at INTEGER;
ALTER TABLE shares ADD COLUMN relayed_at INTEGER;
CREATE INDEX IF NOT EXISTS shares_old_token ON shares (old_token_hash) WHERE old_token_hash IS NOT NULL;

-- Push subscriptions made with a share's key: reminders for that one list, for someone who uses it in the
-- browser from the owner's address (no Worker of their own). Their own reminder time and time zone.
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

-- The person's side: lists others share with you, kept by your own Worker for your phone apps. It talks to
-- their owners' Workers for them (the phone app connects to its own Worker only) and reminds you of their
-- deadlines. token: the share key itself (this Worker must present it); it never leaves this Worker.
CREATE TABLE IF NOT EXISTS remotes (
  id          TEXT PRIMARY KEY,
  server      TEXT    NOT NULL,                  -- the owner's Worker (an https origin, checked at join)
  token       TEXT    NOT NULL,
  project_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  access      TEXT    NOT NULL DEFAULT 'view',
  state       TEXT    NOT NULL DEFAULT 'active', -- active | revoked | transferred | left
  converted   INTEGER NOT NULL DEFAULT 0,        -- one app made it an own list after it was revoked
  project_deleted INTEGER NOT NULL DEFAULT 0,    -- the owner deleted the list (no reminders while it is)
  cursor      INTEGER NOT NULL DEFAULT 0,        -- the reminder poll's
  polled_at   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS remotes_active ON remotes (server, project_id) WHERE state = 'active';

-- what the reminder poll keeps of those lists' tasks
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
