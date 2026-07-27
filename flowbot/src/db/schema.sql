-- FlowBot storage.
--
-- WHAT MAY LIVE HERE: telegram identity, preferences, order history, and an
-- OPTIONAL password-locked keystore backup.
--
-- WHAT MAY NEVER LIVE HERE: a password, a mnemonic, a plaintext private key, or
-- anything derived from them. If a column would need one of those to be useful,
-- the feature is wrong, not the schema.

CREATE TABLE IF NOT EXISTS users (
  telegram_id      INTEGER PRIMARY KEY,
  username         TEXT,
  address          TEXT,              -- public address only
  created_at       INTEGER NOT NULL,
  referred_by      INTEGER,           -- telegram_id of referrer
  FOREIGN KEY (referred_by) REFERENCES users(telegram_id)
);

CREATE TABLE IF NOT EXISTS settings (
  telegram_id      INTEGER PRIMARY KEY,
  slippage_bps     INTEGER NOT NULL DEFAULT 50,
  default_amounts  TEXT    NOT NULL DEFAULT '10,50,100',
  notifications    INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Opt-in, off by default. Useless without the user's password, which we never
-- receive — but it does move one factor into our custody, so it is a choice the
-- user makes explicitly, not a default we impose.
CREATE TABLE IF NOT EXISTS keystore_backups (
  telegram_id      INTEGER PRIMARY KEY,
  blob             TEXT    NOT NULL,  -- opaque ciphertext; we cannot open it
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Orders we are watching so we can push a message when one fills.
CREATE TABLE IF NOT EXISTS tracked_orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id      INTEGER NOT NULL,
  order_id         TEXT    NOT NULL,  -- on-chain order id
  side             TEXT    NOT NULL,  -- 'bid' | 'ask'
  price            TEXT    NOT NULL,
  size             TEXT    NOT NULL,
  tx_hash          TEXT,
  status           TEXT    NOT NULL DEFAULT 'open', -- open | filled | cancelled
  created_at       INTEGER NOT NULL,
  notified_at      INTEGER,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_open ON tracked_orders(status, order_id);

CREATE TABLE IF NOT EXISTS trades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id      INTEGER NOT NULL,
  kind             TEXT    NOT NULL,  -- swap | limit | twap | withdraw | deposit
  detail           TEXT    NOT NULL,
  tx_hash          TEXT,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(telegram_id, created_at DESC);

-- User-set price alerts. Non-sensitive: a threshold and a direction.
CREATE TABLE IF NOT EXISTS price_alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER NOT NULL,
  direction    TEXT    NOT NULL,          -- 'above' | 'below'
  price        TEXT    NOT NULL,          -- EURC per USDC, as typed
  created_at   INTEGER NOT NULL,
  triggered_at INTEGER,                   -- set once fired; kept for history
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_alerts_active ON price_alerts(triggered_at, telegram_id);
