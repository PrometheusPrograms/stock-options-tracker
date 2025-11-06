-- Migration: Change net_credit_per_share and risk_capital_per_share to NUMERIC(12,2) for consistency
-- Note: SQLite doesn't enforce NUMERIC precision, but this documents the intent
-- Values are rounded to nearest hundredth in application code using round()

-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table
-- However, since these are just calculated fields and SQLite is type-agnostic,
-- we can keep them as REAL for existing databases. The application code handles rounding.

-- For new databases, the initial schema will use NUMERIC(12,2)
-- For existing databases, REAL works fine since SQLite doesn't enforce types

-- This migration is informational only - no actual changes needed since SQLite is type-agnostic
-- The values stored will be the same regardless of column type declaration

-- Note: Values are rounded to nearest hundredth in Python using round() before insertion
-- Migration 006 will round all existing values in the database to 2 decimal places

