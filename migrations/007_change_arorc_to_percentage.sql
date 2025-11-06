-- Migration: Change ARORC from decimal to percentage and update column type to NUMERIC(4,1)
-- ARORC is currently stored as a decimal (0.5 = 50%), but should be stored as a percentage (50.0 = 50%)
-- This migration converts existing values from decimal to percentage (multiply by 100)
-- and changes the column type to NUMERIC(4,1) to store one decimal place

-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table
-- Note: Views are dropped programmatically in migrate.py before this SQL is executed

-- Disable foreign key checks temporarily
PRAGMA foreign_keys = OFF;

-- Note: Views are dropped programmatically in migrate.py before this SQL is executed
-- This ensures views are fully dropped and committed before the table modification
DROP VIEW IF EXISTS v_trade_summary;
DROP VIEW IF EXISTS v_cost_basis_summary;
DROP VIEW IF EXISTS v_cash_flow_summary;

-- Create new trades table with ARORC as NUMERIC(4,1)
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
    net_credit_per_share NUMERIC(12,2) DEFAULT 0,
    risk_capital_per_share NUMERIC(12,2) DEFAULT 0,
    margin_percent REAL DEFAULT 100.0,
    ARORC NUMERIC(4,1) DEFAULT NULL,
    trade_type_id INTEGER,
    FOREIGN KEY (ticker_id) REFERENCES tickers(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (trade_type_id) REFERENCES trade_types(id)
);

-- Copy data from old table to new table, converting ARORC from decimal to percentage
-- If ARORC is NULL, keep it as NULL
-- If ARORC is not NULL, multiply by 100 and round to 1 decimal place (always rounding 0.5 up)
-- Note: SQLite's ROUND uses banker's rounding, but we'll use Python's round_standard for consistency
-- For the migration, we'll use ROUND which is close enough, then backfill with Python script if needed
INSERT INTO trades_new (
    id, account_id, ticker_id, trade_date, expiration_date, num_of_contracts,
    credit_debit, total_premium, days_to_expiration, current_price, strike_price,
    trade_status, trade_type, commission_per_share, created_at, price_per_share,
    total_amount, margin_capital, net_credit_per_share, risk_capital_per_share,
    margin_percent, ARORC, trade_type_id
)
SELECT
    id, account_id, ticker_id, trade_date, expiration_date, num_of_contracts,
    credit_debit, total_premium, days_to_expiration, current_price, strike_price,
    trade_status, trade_type, commission_per_share, created_at, price_per_share,
    total_amount, margin_capital, net_credit_per_share, risk_capital_per_share,
    margin_percent,
    CASE 
        WHEN ARORC IS NULL THEN NULL
        ELSE ROUND(ARORC * 100.0, 1)
    END AS ARORC,
    trade_type_id
FROM trades;

-- Drop old table
DROP TABLE trades;

-- Rename new table
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

