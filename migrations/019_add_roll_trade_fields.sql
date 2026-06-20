-- Migration 019: Add roll trade tracking fields to trades table

-- Add date_trade_rolled column (TEXT, nullable) - Date when original trade was rolled
ALTER TABLE trades ADD COLUMN date_trade_rolled TEXT;

-- Add closing_debit column (REAL, default 0.0) - Debit amount to close the trade
ALTER TABLE trades ADD COLUMN closing_debit REAL DEFAULT 0.0;

-- Add total_debit column (REAL, default 0.0) - Total debit (closing_debit * num_of_shares)
ALTER TABLE trades ADD COLUMN total_debit REAL DEFAULT 0.0;

-- Add notes column (TEXT, nullable) - Freeform notes field
ALTER TABLE trades ADD COLUMN notes TEXT;


