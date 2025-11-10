-- Migration: Add margin_percent and ARORC calculated fields to trades table
-- margin_percent: Default 100% for all entries
-- ARORC: (365/days_to_expiration) * (net_credit_per_share / (risk_capital_per_share * margin_percent))
--        Only calculated for ROCT PUT and RULE ONE PUT trades

-- Add margin_percent column with default value of 100
ALTER TABLE trades ADD COLUMN margin_percent REAL DEFAULT 100.0;

-- Add ARORC column (calculated field)
ALTER TABLE trades ADD COLUMN ARORC REAL DEFAULT NULL;

-- Update existing records to set margin_percent to 100 where it's NULL
UPDATE trades SET margin_percent = 100.0 WHERE margin_percent IS NULL;

-- Calculate ARORC for existing ROCT PUT and RULE ONE PUT trades
UPDATE trades 
SET ARORC = (365.0 / days_to_expiration) * (net_credit_per_share / (risk_capital_per_share * margin_percent))
WHERE (trade_type LIKE '%ROCT%PUT%' OR trade_type LIKE '%ROCT%ROP%' OR trade_type LIKE '%RULE ONE%PUT%' OR 
       (trade_type LIKE '%PUT%' AND (trade_type LIKE '%ROCT%' OR trade_type LIKE '%RULE ONE%')))
  AND days_to_expiration > 0
  AND risk_capital_per_share IS NOT NULL
  AND risk_capital_per_share > 0
  AND net_credit_per_share IS NOT NULL
  AND margin_percent IS NOT NULL
  AND margin_percent > 0;





