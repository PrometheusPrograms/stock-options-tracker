-- Migration: Rename trade_date to date_trade_open and add date_trade_closed
-- This migration renames the trade_date column to date_trade_open and adds a new date_trade_closed column

-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table
-- Note: Views are dropped programmatically in migrate.py before this SQL is executed

-- Disable foreign key checks temporarily
PRAGMA foreign_keys = OFF;

-- Note: Views are dropped programmatically in migrate.py before this SQL is executed
-- This ensures views are fully dropped and committed before the table modification
DROP VIEW IF EXISTS v_trade_summary;
DROP VIEW IF EXISTS v_cost_basis_summary;
DROP VIEW IF EXISTS v_cash_flow_summary;

-- Create new trades table with renamed column and new column
CREATE TABLE trades_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER DEFAULT 9,
    ticker_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    date_trade_open TEXT NOT NULL,
    date_trade_closed TEXT DEFAULT NULL,
    expiration_date TEXT NOT NULL,
    num_of_contracts INTEGER NOT NULL,
    num_of_shares INTEGER DEFAULT NULL,
    credit_debit REAL NOT NULL,
    total_premium REAL NOT NULL,
    days_to_expiration INTEGER NOT NULL,
    current_price REAL NOT NULL,
    strike_price NUMERIC(12,2) NOT NULL,
    trade_status TEXT DEFAULT 'open',
    trade_type TEXT NOT NULL,
    commission_per_share REAL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    price_per_share REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    margin_capital REAL DEFAULT 0,
    net_credit_per_share NUMERIC(12,5) DEFAULT 0,
    risk_capital_per_share REAL DEFAULT 0,
    margin_percent REAL DEFAULT 100.0,
    ARORC NUMERIC(10,4) DEFAULT NULL,
    trade_type_id INTEGER,
    trade_parent_id INTEGER,
    FOREIGN KEY (ticker_id) REFERENCES tickers(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (trade_type_id) REFERENCES trade_types(id),
    FOREIGN KEY (trade_parent_id) REFERENCES trades(id)
);

-- Copy data from old table to new table, renaming trade_date to date_trade_open
INSERT INTO trades_new (
    id, account_id, ticker_id, ticker, date_trade_open, date_trade_closed, expiration_date, num_of_contracts, num_of_shares,
    credit_debit, total_premium, days_to_expiration, current_price, strike_price, trade_status, trade_type,
    commission_per_share, created_at, price_per_share, total_amount, margin_capital, net_credit_per_share,
    risk_capital_per_share, margin_percent, ARORC, trade_type_id, trade_parent_id
)
SELECT 
    id, account_id, ticker_id, ticker, trade_date, NULL, expiration_date, num_of_contracts, num_of_shares,
    credit_debit, total_premium, days_to_expiration, current_price, strike_price, trade_status, trade_type,
    commission_per_share, created_at, price_per_share, total_amount, margin_capital, net_credit_per_share,
    risk_capital_per_share, margin_percent, ARORC, trade_type_id, trade_parent_id
FROM trades;

-- Drop old table
DROP TABLE trades;

-- Rename new table to trades
ALTER TABLE trades_new RENAME TO trades;

-- Recreate indexes with new column name
CREATE INDEX IF NOT EXISTS idx_trades_date_trade_open ON trades(date_trade_open);
CREATE INDEX IF NOT EXISTS idx_trades_account_date ON trades(account_id, date_trade_open);
CREATE INDEX IF NOT EXISTS idx_trades_account_status_date ON trades(account_id, trade_status, date_trade_open);

-- Re-enable foreign key checks
PRAGMA foreign_keys = ON;






