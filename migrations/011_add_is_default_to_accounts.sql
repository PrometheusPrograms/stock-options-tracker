-- Migration: Add is_default column to accounts table
-- This allows marking one account as the default account

-- Add is_default column if it doesn't exist
-- SQLite supports ALTER TABLE ADD COLUMN, so this is straightforward
ALTER TABLE accounts ADD COLUMN is_default BOOLEAN DEFAULT 0;

-- Set a default account if none exists
-- First try to set 'Rule One' as default if it exists and no default is set
UPDATE accounts 
SET is_default = 1 
WHERE account_name = 'Rule One'
AND (SELECT COUNT(*) FROM accounts WHERE is_default = 1) = 0;

-- If no default was set (Rule One doesn't exist or update didn't happen), set the first account as default
UPDATE accounts 
SET is_default = 1 
WHERE id = (SELECT id FROM accounts ORDER BY id LIMIT 1)
AND (SELECT COUNT(*) FROM accounts WHERE is_default = 1) = 0;

