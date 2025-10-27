-- SQL Views to Simplify Reporting Logic
-- Run these in your database to create the views

-- ============================================================================
-- VIEW 1: Trade Summary View
-- ============================================================================
-- Simplifies querying trades with ticker and account information
CREATE VIEW IF NOT EXISTS v_trade_summary AS
SELECT 
    t.id,
    t.account_id,
    tk.ticker,
    tk.company_name,
    t.trade_date,
    t.expiration_date,
    t.num_of_contracts,
    t.premium,
    t.total_premium,
    t.days_to_expiration,
    t.current_price,
    t.strike_price,
    t.status,
    t.trade_type,
    t.commission,
    t.created_at,
    -- Calculated fields
    t.strike_price - t.premium AS net_credit_per_share,
    (t.strike_price - t.premium) * t.num_of_contracts AS net_credit_total
FROM trades t
JOIN tickers tk ON t.ticker_id = tk.id;

-- ============================================================================
-- VIEW 2: Margin Capital View
-- ============================================================================
-- Calculates margin capital for options trades automatically
CREATE VIEW IF NOT EXISTS v_margin_capital AS
SELECT 
    t.id,
    t.account_id,
    tk.ticker,
    t.status,
    t.trade_type,
    t.trade_date,
    t.num_of_contracts,
    t.strike_price,
    t.premium,
    t.commission,
    -- Margin Capital Calculation
    (t.strike_price - (t.premium - COALESCE(t.commission, 0))) * t.num_of_contracts * 100 AS margin_capital,
    -- Net Credit Calculation  
    (t.premium - COALESCE(t.commission, 0)) AS net_credit_per_share
FROM trades t
JOIN tickers tk ON t.ticker_id = tk.id
WHERE t.trade_type NOT IN ('BTO', 'STC') 
  AND t.status != 'roll'
  AND (
    t.trade_type LIKE '%ROCT PUT%' OR 
    t.trade_type LIKE '%ROCT CALL%' OR
    t.trade_type LIKE '%ROP%' OR
    t.trade_type LIKE '%ROC%'
  );

-- ============================================================================
-- VIEW 3: Cost Basis Summary View
-- ============================================================================
-- Provides aggregated cost basis data per ticker/account
CREATE VIEW IF NOT EXISTS v_cost_basis_summary AS
SELECT 
    cb.ticker_id,
    cb.account_id,
    tk.ticker,
    tk.company_name,
    COUNT(DISTINCT cb.id) AS transaction_count,
    SUM(cb.shares) AS total_shares,
    MAX(cb.running_basis) AS total_cost_basis,
    MAX(cb.basis_per_share) AS cost_basis_per_share,
    MIN(cb.transaction_date) AS first_transaction,
    MAX(cb.transaction_date) AS last_transaction
FROM cost_basis cb
JOIN tickers tk ON cb.ticker_id = tk.id
GROUP BY cb.ticker_id, cb.account_id, tk.ticker, tk.company_name;

-- ============================================================================
-- VIEW 4: Cash Flow Summary View
-- ============================================================================
-- Aggregates cash flows by type and account
CREATE VIEW IF NOT EXISTS v_cash_flow_summary AS
SELECT 
    cf.account_id,
    a.account_name,
    cf.transaction_type,
    COUNT(*) AS transaction_count,
    SUM(cf.amount) AS total_amount,
    MIN(cf.transaction_date) AS first_transaction,
    MAX(cf.transaction_date) AS last_transaction
FROM cash_flows cf
JOIN accounts a ON cf.account_id = a.id
GROUP BY cf.account_id, a.account_name, cf.transaction_type;

-- ============================================================================
-- VIEW 5: Trade Performance View
-- ============================================================================
-- Calculates performance metrics for completed trades
CREATE VIEW IF NOT EXISTS v_trade_performance AS
SELECT 
    t.id,
    t.account_id,
    tk.ticker,
    t.trade_type,
    t.status,
    t.trade_date,
    t.expiration_date,
    t.days_to_expiration,
    t.premium,
    t.total_premium,
    t.commission,
    -- Performance metrics
    t.total_premium - COALESCE(t.commission, 0) AS net_premium,
    CASE 
        WHEN t.status IN ('closed', 'expired', 'assigned') THEN 
            (t.total_premium - COALESCE(t.commission, 0))
        ELSE NULL 
    END AS realized_pnl,
    CASE 
        WHEN t.status = 'open' THEN 
            (t.total_premium - COALESCE(t.commission, 0))
        ELSE NULL 
    END AS unrealized_pnl,
    t.days_to_expiration
FROM trades t
JOIN tickers tk ON t.ticker_id = tk.id;

-- ============================================================================
-- VIEW 6: Account Balance View
-- ============================================================================
-- Calculates current balance for each account
CREATE VIEW IF NOT EXISTS v_account_balance AS
SELECT 
    a.id AS account_id,
    a.account_name,
    a.account_type,
    a.starting_balance,
    -- Total from cash flows
    COALESCE(SUM(cf.amount), 0) AS total_cash_flows,
    -- Current balance
    a.starting_balance + COALESCE(SUM(cf.amount), 0) AS current_balance,
    -- Counts
    COUNT(DISTINCT cf.id) AS transaction_count
FROM accounts a
LEFT JOIN cash_flows cf ON a.id = cf.account_id
GROUP BY a.id, a.account_name, a.account_type, a.starting_balance;

-- ============================================================================
-- VIEW 7: Bankroll Allocation View
-- ============================================================================
-- Shows how bankroll is allocated across account, trades, etc.
CREATE VIEW IF NOT EXISTS v_bankroll_allocation AS
SELECT 
    a.id AS account_id,
    a.account_name,
    a.starting_balance AS starting_bankroll,
    -- Premiums from trades
    COALESCE(SUM(
        CASE 
            WHEN t.status != 'roll' THEN t.total_premium
            ELSE 0
        END
    ), 0) AS total_premiums,
    -- Available bankroll
    a.starting_balance + COALESCE(SUM(
        CASE 
            WHEN t.status != 'roll' THEN t.total_premium
            ELSE 0
        END
    ), 0) AS total_available,
    -- Used in open trades (from v_margin_capital)
    COALESCE((
        SELECT SUM(margin_capital)
        FROM v_margin_capital vm
        WHERE vm.account_id = a.id
          AND vm.status IN ('open', 'assigned')
    ), 0) AS used_in_trades
FROM accounts a
LEFT JOIN trades t ON a.id = t.account_id
GROUP BY a.id, a.account_name, a.starting_balance;

-- ============================================================================
-- VIEW 8: Trade Statistics View
-- ============================================================================
-- Aggregated statistics per account/status
CREATE VIEW IF NOT EXISTS v_trade_statistics AS
SELECT 
    t.account_id,
    t.status,
    COUNT(*) AS trade_count,
    SUM(t.total_premium) AS total_premium,
    AVG(t.total_premium) AS avg_premium,
    SUM(t.commission) AS total_commission,
    SUM(t.total_premium - COALESCE(t.commission, 0)) AS net_premium,
    MIN(t.trade_date) AS first_trade_date,
    MAX(t.trade_date) AS last_trade_date
FROM trades t
WHERE t.status != 'roll'
GROUP BY t.account_id, t.status;

