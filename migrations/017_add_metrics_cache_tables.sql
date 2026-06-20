-- Migration 017: Add metrics cache tables for trade summaries and bankroll allocation
-- These tables cache precomputed metrics to avoid recalculation on every UI refresh

-- ============================================================================
-- Trade Summary Cache Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS trade_summary_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    status TEXT,
    trade_count INTEGER NOT NULL DEFAULT 0,
    total_premium REAL NOT NULL DEFAULT 0,
    avg_premium REAL NOT NULL DEFAULT 0,
    total_commission REAL NOT NULL DEFAULT 0,
    net_premium REAL NOT NULL DEFAULT 0,
    first_trade_date TEXT,
    last_trade_date TEXT,
    cache_key TEXT UNIQUE NOT NULL, -- Composite key: account_id_status or 'all_status'
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_trade_summary_cache_key ON trade_summary_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_trade_summary_cache_account ON trade_summary_cache(account_id);

-- ============================================================================
-- Bankroll Allocation Cache Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS bankroll_allocation_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    status_filter TEXT, -- 'open', 'completed', 'assigned', or NULL for all
    start_date TEXT, -- Date filter start (NULL if no filter)
    end_date TEXT, -- Date filter end (NULL if no filter)
    starting_bankroll REAL NOT NULL DEFAULT 0,
    total_premiums REAL NOT NULL DEFAULT 0,
    total_bankroll REAL NOT NULL DEFAULT 0,
    used_in_trades REAL NOT NULL DEFAULT 0,
    available_bankroll REAL NOT NULL DEFAULT 0,
    cache_key TEXT UNIQUE NOT NULL, -- Composite key: account_id_status_start_end
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_bankroll_cache_key ON bankroll_allocation_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_bankroll_cache_account ON bankroll_allocation_cache(account_id);

-- ============================================================================
-- Trade Statistics Cache Table (from v_trade_statistics view)
-- ============================================================================
CREATE TABLE IF NOT EXISTS trade_statistics_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    status TEXT,
    trade_count INTEGER NOT NULL DEFAULT 0,
    total_premium REAL NOT NULL DEFAULT 0,
    avg_premium REAL NOT NULL DEFAULT 0,
    total_commission REAL NOT NULL DEFAULT 0,
    net_premium REAL NOT NULL DEFAULT 0,
    first_trade_date TEXT,
    last_trade_date TEXT,
    cache_key TEXT UNIQUE NOT NULL, -- Composite key: account_id_status
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_trade_stats_cache_key ON trade_statistics_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_trade_stats_cache_account ON trade_statistics_cache(account_id);





