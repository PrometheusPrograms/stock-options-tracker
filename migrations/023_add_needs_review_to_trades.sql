-- Migration 023: Add needs_review flag for Schwab-imported trades that need manual verification
ALTER TABLE trades ADD COLUMN needs_review INTEGER DEFAULT 0;
