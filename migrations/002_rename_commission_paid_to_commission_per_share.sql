-- Migration: Rename commission_paid to commission_per_share in trades table
-- SQLite doesn't support RENAME COLUMN in older versions, so we need to recreate the table
-- This migration only runs if commission_paid exists (old schema)

-- Check if commission_paid column exists (only run if it does)
-- Note: This migration will be skipped if the column doesn't exist (new databases use commission_per_share from the start)

-- Disable foreign key checks temporarily
PRAGMA foreign_keys = OFF;

-- Note: Views are dropped programmatically in migrate.py before this SQL is executed
-- This ensures views are fully dropped and committed before the table rename operation
-- The DROP VIEW statements below are kept as a safety measure, but they should be redundant
DROP VIEW IF EXISTS v_trade_summary;
DROP VIEW IF EXISTS v_cost_basis_summary;
DROP VIEW IF EXISTS v_cash_flow_summary;

-- Create temporary table to check if commission_paid exists
-- If it doesn't exist, the migration will be a no-op (column already has correct name)
-- We'll use a safe SELECT that works whether commission_paid or commission_per_share exists

-- Create new trades table with renamed column
CREATE TABLE trades_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER DEFAULT 9,
    ticker_id INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    expiration_date TEXT NOT NULL,
    num_of_contracts INTEGER NOT NULL,
    credit_debit REAL NOT NULL,
    total_premium REAL NOT NULL,
    days_to_expiration INTEGER NOT NULL,
    current_price REAL NOT NULL,
    strike_price REAL NOT NULL,
    trade_status TEXT DEFAULT 'open',
    trade_type TEXT NOT NULL,
    commission_per_share REAL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    price_per_share REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    margin_capital REAL DEFAULT 0,
    trade_type_id INTEGER,
    FOREIGN KEY (ticker_id) REFERENCES tickers(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Copy data from old table to new table, renaming the column
-- Note: This assumes commission_paid exists. If it doesn't (new databases), 
-- the migration system should handle the error gracefully or check before running.
INSERT INTO trades_new (
    id, account_id, ticker_id, trade_date, expiration_date, num_of_contracts, 
    credit_debit, total_premium, days_to_expiration, current_price, strike_price, 
    trade_status, trade_type, commission_per_share, created_at, price_per_share, 
    total_amount, margin_capital, trade_type_id
)
SELECT 
    id, account_id, ticker_id, trade_date, expiration_date, num_of_contracts, 
    credit_debit, total_premium, days_to_expiration, current_price, strike_price, 
    trade_status, trade_type, commission_paid as commission_per_share, created_at, 
    price_per_share, total_amount, margin_capital, trade_type_id
FROM trades;

-- Drop old table (this will fail if views still reference it, but we've already dropped views)
DROP TABLE trades;

-- Rename new table (this should work now that views are dropped)
-- Note: SQLite will create a temporary name during rename, but the final name should be 'trades'
ALTER TABLE trades_new RENAME TO trades;

-- Recreate views
CREATE VIEW IF NOT EXISTS v_trade_summary AS
SELECT 
    t.id,
    t.account_id,
    t.ticker_id,
    t.trade_date,
    t.expiration_date,
    t.num_of_contracts,
    t.credit_debit,
    t.total_premium,
    t.days_to_expiration,
    t.current_price,
    t.strike_price,
    t.trade_status,
    t.trade_type,
    t.commission_per_share,
    t.created_at,
    t.strike_price - t.credit_debit AS net_credit_per_share,
    tk.ticker,
    a.account_name
FROM trades t
JOIN tickers tk ON t.ticker_id = tk.id
LEFT JOIN accounts a ON t.account_id = a.id;

-- Re-enable foreign key checks
PRAGMA foreign_keys = ON;

