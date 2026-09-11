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

CREATE INDEX IF NOT EXISTS pool_rows_eligible_fifo_idx
  ON pool_rows (password, pool_id, inserted_at, row_key)
  WHERE state = 'available'
    AND lower(COALESCE(data->>'wa_status', data->>'waStatus', '')) = 'eligible';

CREATE INDEX IF NOT EXISTS pool_rows_hold_idx
  ON pool_rows (password, pool_id, hold_id)
  WHERE hold_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('CREDIT', 'DEBIT')),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  balance_after NUMERIC NOT NULL,
  description TEXT NOT NULL,
  meta JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_tx_user_idx ON wallet_transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS meta_key_prefix_idx ON meta (k text_pattern_ops);

CREATE INDEX IF NOT EXISTS file_rows_key_idx
  ON file_rows (file_id, (COALESCE(NULLIF(data->>'uid', ''), substring(data->>'cookies' FROM 'c_user=([0-9]+)'))))
  WHERE COALESCE(NULLIF(data->>'uid', ''), substring(data->>'cookies' FROM 'c_user=([0-9]+)')) IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;

-- 002: dead pool rows — the worker moves held rows whose UID checked dead to state='dead';
-- dead rows are skipped by selection/counts, stay visible for row coloring, and are never paid
ALTER TABLE pool_rows DROP CONSTRAINT IF EXISTS pool_rows_state_check;
ALTER TABLE pool_rows ADD CONSTRAINT pool_rows_state_check
  CHECK (state IN ('available', 'held', 'claimed', 'dead'));

CREATE INDEX IF NOT EXISTS pool_rows_held_idx
  ON pool_rows (row_key) WHERE state = 'held';

-- 003: approval revert window - the first approve/reject starts a 5-minute window in which the
-- decision may be flipped exactly once (max 2 actions). Wallets are paid once at settlement
-- (first_action_at + 5min) by the backend sweeper, based on the final status: APPROVED credits
-- owners for rows still claimed by the hold; REJECTED pays nothing. Rows finished under the old
-- immediate-payout rules are frozen as fully actioned + settled.
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS first_action_at BIGINT;
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS action_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS settled BOOLEAN NOT NULL DEFAULT false;

UPDATE downloads SET settled = true, action_count = 2
WHERE settled = false AND status IN ('APPROVED', 'REJECTED', 'REVERTED');

CREATE INDEX IF NOT EXISTS downloads_settle_idx
  ON downloads (first_action_at) WHERE settled = false;

-- 004: single-pool membership — adds check row_key globally (any password/pool) before insert;
-- sold (claimed) accounts can never re-enter any pool; dead rows are removed on re-feed
CREATE INDEX IF NOT EXISTS pool_rows_rowkey_idx
  ON pool_rows (row_key);

-- 005: invalid/incomplete accounts - rows from 2fa/page files missing the 2fa key are rejected
-- at feed time (strict routing: never cookies_only) and counted per pool, deduped per account;
-- cleared when the account is later pooled successfully
CREATE TABLE IF NOT EXISTS pool_rejects (
  password TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  row_key TEXT NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (password, pool_id, row_key)
);

-- 006: drop pool_ledger — the only reader (per-pool ledger route) was never called by any client;
-- removing it kills one INSERT per pool add/claim/hold/approve/reject and drops a write-heavy table
DROP TABLE IF EXISTS pool_ledger;

-- 007: permanent sold/dead UID blocklist — sold or died-on-hold accounts can never
-- re-enter any pool, even after their file is deleted (deletes wipe pool rows, so without
-- this the same accounts could be re-uploaded and resold). Keyed globally by account key.
CREATE TABLE IF NOT EXISTS pool_blocked (
  row_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('sold','dead')),
  password TEXT,
  pool_id TEXT,
  src_uid TEXT,
  hold_id TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_blocked_ts_idx ON pool_blocked (ts);

-- backfill: currently claimed rows + dead-while-held rows + every key from a decided-sold
-- download (APPROVED/CLAIMED, not reverted — covers files already deleted)
INSERT INTO pool_blocked(row_key,reason,password,pool_id,src_uid,hold_id,ts)
SELECT row_key,'sold',password,pool_id,src_uid,hold_id,COALESCE(claimed_at,inserted_at) FROM pool_rows WHERE state='claimed'
ON CONFLICT(row_key) DO NOTHING;
INSERT INTO pool_blocked(row_key,reason,password,pool_id,src_uid,hold_id,ts)
SELECT row_key,'dead',password,pool_id,src_uid,hold_id,inserted_at FROM pool_rows WHERE state='dead' AND hold_id IS NOT NULL
ON CONFLICT(row_key) DO NOTHING;
INSERT INTO pool_blocked(row_key,reason,password,pool_id,src_uid,hold_id,ts)
SELECT DISTINCT k,'sold',d.password,d.pool_id,NULL,d.id,d.ts FROM downloads d, jsonb_array_elements_text(d.keys) k WHERE d.status IN ('APPROVED','CLAIMED') AND d.reverted=false
ON CONFLICT(row_key) DO NOTHING;
