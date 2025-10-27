-- SQL Index Recommendations for SQLite Optimization
-- Run these to create indexes for better query performance

-- ============================================================================
-- TRADES TABLE INDEXES
-- ============================================================================
-- Filter by account (most common filter)
CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account_id);

-- Filter by status (very common in queries)
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- Filter by ticker (for JOINs and filtering)
CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker_id);

-- Filter by trade date ranges (very common)
CREATE INDEX IF NOT EXISTS idx_trades_trade_date ON trades(trade_date);

-- Composite: account + status (common query pattern)
CREATE INDEX IF NOT EXISTS idx_trades_account_status ON trades(account_id, status);

-- Composite: account + trade date (for date filtering per account)
CREATE INDEX IF NOT EXISTS idx_trades_account_date ON trades(account_id, trade_date);

-- Filter by trade type
CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(trade_type);

-- Sort by created_at (default listing)
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);

-- Composite: account + status + date (most common filter combo)
CREATE INDEX IF NOT EXISTS idx_trades_account_status_date ON trades(account_id, status, trade_date);

-- ============================================================================
-- COST_BASIS TABLE INDEXES
-- ============================================================================
-- Filter by ticker and account (most common queries)
CREATE INDEX IF NOT EXISTS idx_cost_basis_ticker_account ON cost_basis(ticker_id, account_id);

-- Sort by transaction date (chronological order for running totals)
CREATE INDEX IF NOT EXISTS idx_cost_basis_transaction_date ON cost_basis(transaction_date);

-- Filter by account
CREATE INDEX IF NOT EXISTS idx_cost_basis_account ON cost_basis(account_id);

-- Filter by ticker
CREATE INDEX IF NOT EXISTS idx_cost_basis_ticker ON cost_basis(ticker_id);

-- Composite: ticker + account + date (for chronological queries)
CREATE INDEX IF NOT EXISTS idx_cost_basis_ticker_account_date ON cost_basis(ticker_id, account_id, transaction_date);

-- ============================================================================
-- CASH_FLOWS TABLE INDEXES
-- ============================================================================
-- Filter by account (very common)
CREATE INDEX IF NOT EXISTS idx_cash_flows_account ON cash_flows(account_id);

-- Filter by transaction type
CREATE INDEX IF NOT EXISTS idx_cash_flows_type ON cash_flows(transaction_type);

-- Filter by transaction date (date ranges)
CREATE INDEX IF NOT EXISTS idx_cash_flows_date ON cash_flows(transaction_date);

-- Composite: account + date (common query pattern)
CREATE INDEX IF NOT EXISTS idx_cash_flows_account_date ON cash_flows(account_id, transaction_date);

-- Composite: account + type (for summaries)
CREATE INDEX IF NOT EXISTS idx_cash_flows_account_type ON cash_flows(account_id, transaction_type);

-- Filter by ticker (for ticker-specific cash flows)
CREATE INDEX IF NOT EXISTS idx_cash_flows_ticker ON cash_flows(ticker_id);

-- ============================================================================
-- COMMISSIONS TABLE INDEXES
-- ============================================================================
-- Composite: account + effective_date (for lookup by date)
CREATE INDEX IF NOT EXISTS idx_commissions_account_date ON commissions(account_id, effective_date);

-- Filter by account
CREATE INDEX IF NOT EXISTS idx_commissions_account ON commissions(account_id);

-- ============================================================================
-- BANKROLL TABLE INDEXES
-- ============================================================================
-- Filter by account
CREATE INDEX IF NOT EXISTS idx_bankroll_account ON bankroll(account_id);

-- Filter by transaction date
CREATE INDEX IF NOT EXISTS idx_bankroll_date ON bankroll(transaction_date);

-- Composite: account + date
CREATE INDEX IF NOT EXISTS idx_bankroll_account_date ON bankroll(account_id, transaction_date);

-- ============================================================================
-- TRADE_STATUS_HISTORY INDEXES
-- ============================================================================
-- Filter by trade_id (for history lookups)
CREATE INDEX IF NOT EXISTS idx_trade_status_trade ON trade_status_history(trade_id);

-- Sort by changed_at (chronological order)
CREATE INDEX IF NOT EXISTS idx_trade_status_changed ON trade_status_history(changed_at DESC);

