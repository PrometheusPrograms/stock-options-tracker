-- Migration: Round net_credit_per_share and risk_capital_per_share to 2 decimal places
-- This updates all existing values in the database to have exactly 2 decimal places
-- by rounding to the nearest hundredth, always rounding 0.5 up (standard rounding)

-- SQLite doesn't enforce precision, but we want to ensure all values are rounded
-- Note: SQLite's ROUND function uses banker's rounding (round half to even)
-- For standard rounding (always round 0.5 up), we need to use Python's round_standard function
-- This migration will be handled by a Python script that uses round_standard()

-- The Python script will update all values using round_standard() which always rounds 0.5 up
-- This ensures: 69.835 -> 69.84, 0.115 -> 0.12, 0.114 -> 0.11

