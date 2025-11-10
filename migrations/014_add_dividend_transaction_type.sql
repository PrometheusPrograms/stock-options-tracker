-- Migration: Add 'Dividend' to allowed transaction types in cash_flows table

-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table
-- Note: Views are dropped programmatically in migrate.py before this SQL is executed

-- Disable foreign key checks temporarily
PRAGMA foreign_keys = OFF;

-- Note: Views are dropped programmatically in migrate.py before this SQL is executed
-- This ensures views are fully dropped and committed before the table modification
DROP VIEW IF EXISTS v_trade_summary;
DROP VIEW IF EXISTS v_cost_basis_summary;
DROP VIEW IF EXISTS v_cash_flow_summary;

-- Create new cash_flows table with 'Dividend' in CHECK constraint
CREATE TABLE cash_flows_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    transaction_date TEXT NOT NULL,
    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'ASSIGNMENT', 'SELL PUT', 'SELL CALL', 'Dividend')),
    amount NUMERIC(12,2) NOT NULL,
    description TEXT,
    trade_id INTEGER,
    ticker_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (trade_id) REFERENCES trades(id),
    FOREIGN KEY (ticker_id) REFERENCES tickers(id)
);

-- Copy data from old table to new table
INSERT INTO cash_flows_new (
    id, account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id, created_at
)
SELECT 
    id, account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id, created_at
FROM cash_flows;

-- Drop old table
DROP TABLE cash_flows;

-- Rename new table
ALTER TABLE cash_flows_new RENAME TO cash_flows;

-- Recreate views
CREATE VIEW IF NOT EXISTS v_trade_summary AS
SELECT
    t.id,
    t.account_id,
    t.ticker_id,
    t.trade_date,
    t.expiration_date,
    t.num_of_contracts,
    t.num_of_shares,
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
    a.account_name,
    t.trade_parent_id
FROM trades t
JOIN tickers tk ON t.ticker_id = tk.id
LEFT JOIN accounts a ON t.account_id = a.id;

-- Re-enable foreign key checks
PRAGMA foreign_keys = ON;

