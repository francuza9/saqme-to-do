-- The AI connector (src/connector.js, src/mcp.js): one row. Its key is derived from the sync key and `nonce`
-- (HMAC-SHA-256), so neither the key nor anything that gives it without the sync key is stored here. Made for
-- every database with this migration, so sync set up (or updated) means a connector address is ready; rotating
-- it is a new nonce, disconnecting it is enabled = 0 (and a new nonce). The rest is its rate limits.
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
