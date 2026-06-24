-- Migration 022: Add long_strike column for spread trades (e.g. ROCS BULL PUT SPREAD)
-- short_strike uses the existing strike_price column; this adds the long (bought) strike

ALTER TABLE trades ADD COLUMN long_strike NUMERIC(12,2) DEFAULT NULL;
