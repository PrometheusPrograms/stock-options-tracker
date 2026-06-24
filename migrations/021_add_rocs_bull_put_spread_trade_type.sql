-- Migration 021: Add ROCS BULL PUT SPREAD trade type
-- ROCS = Rule One Credit Spread; Bull Put Spread is a credit spread
-- where the short put strike is above the long put strike

INSERT OR IGNORE INTO trade_types (type_name, description, category, is_credit, requires_expiration, requires_strike, requires_contracts, requires_shares)
VALUES ('ROCS BULL PUT SPREAD', 'Rule One Credit Spread - Bull Put Spread', 'OPTIONS', 1, 1, 1, 1, 0);
