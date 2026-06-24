-- Migration 024: Expand cash_flow transaction_type CHECK constraint to include new Schwab sync types

BEGIN;

-- SQLite doesn't support ALTER TABLE ... MODIFY CONSTRAINT.
-- We must recreate the table with the new constraint.

CREATE TABLE cash_flows_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    transaction_date TEXT NOT NULL,
    transaction_type TEXT NOT NULL CHECK(transaction_type IN (
        'DEPOSIT', 'WITHDRAWAL',
        'PREMIUM_CREDIT', 'PREMIUM_DEBIT',
        'ASSIGNMENT',
        'SELL PUT', 'SELL CALL',
        'BUY PUT', 'BUY CALL',
        'CLOSING_DEBIT',
        'Dividend'
    )),
    amount NUMERIC(12,2) NOT NULL,
    description TEXT,
    trade_id INTEGER,
    ticker_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (trade_id) REFERENCES trades(id),
    FOREIGN KEY (ticker_id) REFERENCES tickers(id)
);

INSERT INTO cash_flows_new SELECT * FROM cash_flows;

DROP TABLE cash_flows;

ALTER TABLE cash_flows_new RENAME TO cash_flows;

COMMIT;
