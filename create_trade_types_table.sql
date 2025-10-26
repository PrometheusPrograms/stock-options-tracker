-- Create trade_types lookup table
CREATE TABLE IF NOT EXISTS trade_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_code TEXT UNIQUE NOT NULL,
    type_name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,  -- 'OPTIONS', 'STOCK', 'SPECIAL'
    is_credit BOOLEAN DEFAULT 0,  -- Does this trade collect premium?
    requires_expiration BOOLEAN DEFAULT 1,  -- Does this need expiration date?
    requires_strike BOOLEAN DEFAULT 1,  -- Does this need strike price?
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert all valid trade types
INSERT INTO trade_types (type_code, type_name, description, category, is_credit, requires_expiration, requires_strike) VALUES
('ROCT_PUT', 'ROCT PUT', 'Roll Over Cash-secured PUT', 'OPTIONS', 1, 1, 1),
('ROCT_CALL', 'ROCT CALL', 'Roll Over Cash-secured CALL', 'OPTIONS', 1, 1, 1),
('BTO', 'BTO', 'Buy To Open Stock', 'STOCK', 0, 1, 0),
('STC', 'STC', 'Sell To Close Stock', 'STOCK', 0, 1, 0),
('ASSIGNED', 'ASSIGNED', 'Assigned Option Contract', 'SPECIAL', 0, 0, 1),
('ROLL', 'ROLL', 'Rolled Trade', 'SPECIAL', 0, 1, 1);

-- Add foreign key to stock_trades (if it doesn't exist)
-- Note: SQLite doesn't support adding constraints to existing columns easily
-- This would require recreating the table or using ALTER TABLE with PRAGMA foreign_keys

-- Query to show all trade types
SELECT * FROM trade_types;
