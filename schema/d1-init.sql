-- Foundations D1 schema. Mirrors the relevant bits of ECHO's audit log
-- so dashboards can share queries.

CREATE TABLE IF NOT EXISTS chat_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  bot         TEXT    NOT NULL,   -- e.g. 'foundations-chat', 'foundations-health'
  event       TEXT    NOT NULL,   -- e.g. 'answered', 'refused_advanced', 'no_context'
  user        TEXT,               -- cf-access email if present
  q           TEXT,
  a           TEXT,
  elapsed_ms  INTEGER,
  success     INTEGER NOT NULL DEFAULT 1,  -- 1 = ok, 0 = error
  reason      TEXT,
  meta_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_log_ts          ON chat_log(ts);
CREATE INDEX IF NOT EXISTS idx_chat_log_bot_ts      ON chat_log(bot, ts);
CREATE INDEX IF NOT EXISTS idx_chat_log_event_ts    ON chat_log(event, ts);
CREATE INDEX IF NOT EXISTS idx_chat_log_user_ts     ON chat_log(user, ts);
