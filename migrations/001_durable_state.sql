CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version = 1),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64)
) STRICT;
CREATE TABLE bindings (
  namespace TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64)
) STRICT;
CREATE TABLE executions (
  key TEXT PRIMARY KEY,
  command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
  owner TEXT,
  context TEXT,
  instance_id TEXT,
  agent_id TEXT,
  subject_ref TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('reserved','started','not-started','uncertain','completed','pending','failed')),
  error_code TEXT,
  outcome TEXT CHECK (outcome IN ('not-started','uncertain','completed','pending','failed')),
  operation_id TEXT,
  poll_after_ms INTEGER,
  pending_expires_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  compacted INTEGER NOT NULL DEFAULT 0 CHECK (compacted IN (0,1)),
  UNIQUE (instance_id, agent_id, subject_ref, operation_id)
) STRICT;
CREATE TABLE actions (
  key TEXT PRIMARY KEY,
  command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
  owner TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('reserved','result-confirmed','delivery-pending','delivery-started','delivered','delivery-uncertain','delivery-rejected')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;
CREATE TABLE offsets (
  namespace TEXT PRIMARY KEY,
  offset INTEGER NOT NULL CHECK (offset >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  record_key TEXT NOT NULL,
  event TEXT NOT NULL,
  at INTEGER NOT NULL CHECK (at >= 0)
) STRICT;
CREATE INDEX audit_record ON audit(record_key, at);
PRAGMA application_id = 1246901078;
PRAGMA user_version = 1;
