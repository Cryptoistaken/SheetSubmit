CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  photo_url TEXT,
  phone TEXT,
  banned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS file_index (
  file_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  archived BOOLEAN NOT NULL DEFAULT false,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS file_index_owner_archived_idx
  ON file_index (owner_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  exp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions (exp);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  balance NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS file_meta (
  file_id TEXT PRIMARY KEY REFERENCES file_index(file_id) ON DELETE CASCADE,
  data JSONB,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_rows (
  file_id TEXT NOT NULL REFERENCES file_index(file_id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

CREATE TABLE IF NOT EXISTS file_logs (
  file_id TEXT NOT NULL REFERENCES file_index(file_id) ON DELETE CASCADE,
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  ts BIGINT NOT NULL,
  action TEXT,
  seq INTEGER,
  PRIMARY KEY (file_id, id)
);

CREATE INDEX IF NOT EXISTS file_logs_recent_idx
  ON file_logs (file_id, id DESC);

CREATE TABLE IF NOT EXISTS pool_settings (
  password TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  price NUMERIC NOT NULL CHECK (price >= 0 AND price <= 1000),
  PRIMARY KEY (password, pool_id)
);

CREATE TABLE IF NOT EXISTS pool_rows (
  password TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  row_key TEXT NOT NULL,
  data JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'available'
    CHECK (state IN ('available', 'held', 'claimed')),
  claimed_by TEXT,
  claimed_at BIGINT,
  src_uid TEXT,
  src_file_id TEXT,
  inserted_at BIGINT NOT NULL,
  hold_id TEXT,
  PRIMARY KEY (password, pool_id, row_key)
);

CREATE INDEX IF NOT EXISTS pool_rows_fifo_idx
  ON pool_rows (password, pool_id, state, inserted_at, row_key);

CREATE INDEX IF NOT EXISTS pool_rows_source_idx
  ON pool_rows (password, pool_id, state, src_uid, src_file_id, inserted_at, row_key);

CREATE INDEX IF NOT EXISTS pool_rows_hold_idx
  ON pool_rows (password, pool_id, hold_id)
  WHERE hold_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pool_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  password TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  row_key TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  ts BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS pool_ledger_recent_idx
  ON pool_ledger (password, pool_id, id DESC);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  claimed_by TEXT,
  claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed >= 0),
  filename TEXT,
  keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  reverted BOOLEAN NOT NULL DEFAULT false,
  ts BIGINT NOT NULL,
  status TEXT,
  unit_price NUMERIC,
  total NUMERIC,
  mode TEXT,
  src_uids JSONB,
  src_file_ids JSONB,
  selection JSONB
);

CREATE INDEX IF NOT EXISTS downloads_status_recent_idx
  ON downloads (password, status, ts DESC);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS meta_key_prefix_idx ON meta (k text_pattern_ops);

INSERT INTO schema_migrations(version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;
