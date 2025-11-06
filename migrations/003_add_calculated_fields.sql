-- Migration: Add calculated fields net_credit_per_share and risk_capital_per_share to trades table
-- net_credit_per_share = credit_debit - commission_per_share
-- risk_capital_per_share = strike_price - net_credit_per_share (only for ROCT PUT trades)

-- Add net_credit_per_share column
ALTER TABLE trades ADD COLUMN net_credit_per_share REAL DEFAULT 0;

-- Add risk_capital_per_share column
ALTER TABLE trades ADD COLUMN risk_capital_per_share REAL DEFAULT 0;

-- Calculate and populate values for existing records
UPDATE trades 
SET net_credit_per_share = credit_debit - COALESCE(commission_per_share, 0);

-- Calculate risk_capital_per_share for ROCT PUT trades
-- Check if trade_type contains both 'ROCT' and 'PUT' or 'ROP'
UPDATE trades 
SET risk_capital_per_share = strike_price - net_credit_per_share
WHERE (trade_type LIKE '%ROCT%PUT%' OR trade_type LIKE '%ROCT%ROP%' OR (trade_type LIKE '%PUT%' AND trade_type LIKE '%ROCT%'));

