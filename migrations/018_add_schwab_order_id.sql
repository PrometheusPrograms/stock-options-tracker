-- Migration 018: Add Schwab API integration fields to trades table

-- Add column to store Schwab order ID for synced trades
ALTER TABLE trades ADD COLUMN schwab_order_id TEXT;

-- Create index for faster lookups when syncing
CREATE INDEX IF NOT EXISTS idx_trades_schwab_order_id ON trades(schwab_order_id);


