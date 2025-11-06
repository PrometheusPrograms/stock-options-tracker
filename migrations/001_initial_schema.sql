-- Initial schema migration
-- This represents the base schema that should exist

-- Create accounts table
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT UNIQUE NOT NULL,
    account_type TEXT DEFAULT 'PRIMARY',
    start_date TEXT,
    starting_balance REAL DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default accounts
INSERT OR IGNORE INTO accounts (account_name, account_type) 
VALUES ('Rule One', 'INVESTMENT');

-- Create tickers table
CREATE TABLE IF NOT EXISTS tickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT UNIQUE NOT NULL,
    company_name TEXT,
    sector TEXT,
    market_cap REAL,
    needs_update BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create trades table
CREATE TABLE IF NOT EXISTS trades (
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
    strike_price NUMERIC(12,2) NOT NULL,
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
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Create cost_basis table
CREATE TABLE IF NOT EXISTS cost_basis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER DEFAULT 9,
    ticker_id INTEGER NOT NULL,
    trade_id INTEGER,
    cash_flow_id INTEGER,
    transaction_date TEXT NOT NULL,
    description TEXT NOT NULL,
    shares INTEGER NOT NULL,
    cost_per_share REAL NOT NULL,
    total_amount REAL NOT NULL,
    running_basis REAL NOT NULL,
    running_shares INTEGER NOT NULL,
    basis_per_share REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (ticker_id) REFERENCES tickers(id),
    FOREIGN KEY (trade_id) REFERENCES trades(id),
    FOREIGN KEY (cash_flow_id) REFERENCES cash_flows(id)
);

-- Create trade_status_history table
CREATE TABLE IF NOT EXISTS trade_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (trade_id) REFERENCES trades(id)
);

-- Create bankroll table
CREATE TABLE IF NOT EXISTS bankroll (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    transaction_date TEXT NOT NULL,
    transaction_amount REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Create cash_flows table
CREATE TABLE IF NOT EXISTS cash_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    transaction_date TEXT NOT NULL,
    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'OPTIONS', 'ASSIGNMENT', 'BUY', 'SELL')),
    amount NUMERIC(12,2) NOT NULL,
    description TEXT,
    trade_id INTEGER,
    ticker_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (trade_id) REFERENCES trades(id),
    FOREIGN KEY (ticker_id) REFERENCES tickers(id)
);

-- Create commissions table
CREATE TABLE IF NOT EXISTS commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    commission_rate REAL NOT NULL,
    effective_date TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Create trade_types table
CREATE TABLE IF NOT EXISTS trade_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_name TEXT UNIQUE NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    is_credit BOOLEAN DEFAULT 0,
    requires_expiration BOOLEAN DEFAULT 1,
    requires_strike BOOLEAN DEFAULT 1,
    requires_contracts BOOLEAN DEFAULT 1,
    requires_shares BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default trade types
INSERT OR IGNORE INTO trade_types (type_name, description, category, is_credit, requires_expiration, requires_strike, requires_contracts, requires_shares) 
VALUES 
('ROCT PUT', 'Roll Over Cash-secured PUT', 'OPTIONS', 1, 1, 1, 1, 0),
('ROCT CALL', 'Roll Over Cash-secured CALL', 'OPTIONS', 1, 1, 1, 1, 0),
('BTO', 'Buy To Open Stock', 'STOCK', 0, 0, 0, 0, 1),
('STC', 'Sell To Close Stock', 'STOCK', 0, 0, 0, 0, 1);

