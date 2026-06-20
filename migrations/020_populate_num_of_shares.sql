-- Migration 020: Populate num_of_shares for all existing trades

-- Update all existing options trades to populate num_of_shares
-- For options trades (where num_of_shares IS NULL and trade_type NOT IN ('BTO', 'STC')):
-- Set num_of_shares = num_of_contracts * 100
UPDATE trades 
SET num_of_shares = num_of_contracts * 100
WHERE num_of_shares IS NULL 
  AND trade_type NOT IN ('BTO', 'STC');

-- For stock trades, num_of_shares should already be populated, so no update needed


