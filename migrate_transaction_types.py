#!/usr/bin/env python3
"""
Script to migrate cash_flows.transaction_type to new values:
- 'SELL' -> 'SELL PUT' or 'SELL CALL' based on trade_type
- 'ASSIGNMENT' -> 'ASSIGNMENT' (stays the same)
- 'OPTIONS' -> 'PREMIUM_CREDIT' (if exists)
- 'BUY' -> might need different handling
"""

import sqlite3

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def migrate_transaction_types():
    """Migrate transaction_type values to new format"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    print("Creating temporary table without CHECK constraint...")
    
    # Create temporary table without CHECK constraint
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cash_flows_temp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_type TEXT NOT NULL,
            amount NUMERIC(12,2) NOT NULL,
            description TEXT,
            trade_id INTEGER,
            ticker_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id),
            FOREIGN KEY (trade_id) REFERENCES trades(id),
            FOREIGN KEY (ticker_id) REFERENCES tickers(id)
        )
    ''')
    
    # Copy data to temp table
    cursor.execute('''
        INSERT INTO cash_flows_temp 
        SELECT * FROM cash_flows
    ''')
    
    # Migrate 'SELL' to 'SELL PUT' or 'SELL CALL' based on trade_type
    print("Migrating 'SELL' transaction types...")
    cursor.execute('''
        UPDATE cash_flows_temp
        SET transaction_type = CASE
            WHEN EXISTS (
                SELECT 1 FROM trades t 
                WHERE t.id = cash_flows_temp.trade_id 
                AND (t.trade_type LIKE '%PUT%' OR t.trade_type LIKE '%ROP%')
            ) THEN 'SELL PUT'
            WHEN EXISTS (
                SELECT 1 FROM trades t 
                WHERE t.id = cash_flows_temp.trade_id 
                AND (t.trade_type LIKE '%CALL%' OR t.trade_type LIKE '%ROC%')
            ) THEN 'SELL CALL'
            ELSE 'SELL PUT'  -- Default to PUT if can't determine
        END
        WHERE transaction_type = 'SELL'
    ''')
    sell_updated = cursor.rowcount
    print(f"Updated {sell_updated} 'SELL' transactions")
    
    # Migrate 'OPTIONS' to 'PREMIUM_CREDIT' (if any exist)
    print("Migrating 'OPTIONS' transaction types...")
    cursor.execute('''
        UPDATE cash_flows_temp
        SET transaction_type = 'PREMIUM_CREDIT'
        WHERE transaction_type = 'OPTIONS'
    ''')
    options_updated = cursor.rowcount
    print(f"Updated {options_updated} 'OPTIONS' transactions")
    
    # 'ASSIGNMENT' stays the same, no migration needed
    print("'ASSIGNMENT' transactions remain unchanged")
    
    # 'BUY' - check if any exist and what they should be
    cursor.execute("SELECT COUNT(*) as count FROM cash_flows_temp WHERE transaction_type = 'BUY'")
    buy_count = cursor.fetchone()['count']
    if buy_count > 0:
        print(f"Found {buy_count} 'BUY' transactions - these may need manual review")
        # For now, we'll leave them as 'BUY' or could map to something else
    
    conn.commit()
    
    # Now create the new table with updated CHECK constraint
    print("\nCreating new table with updated CHECK constraint...")
    cursor.execute('DROP TABLE IF EXISTS cash_flows')
    cursor.execute('''
        CREATE TABLE cash_flows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'ASSIGNMENT', 'SELL PUT', 'SELL CALL')),
            amount NUMERIC(12,2) NOT NULL,
            description TEXT,
            trade_id INTEGER,
            ticker_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id),
            FOREIGN KEY (trade_id) REFERENCES trades(id),
            FOREIGN KEY (ticker_id) REFERENCES tickers(id)
        )
    ''')
    
    # Copy data from temp table to new table
    cursor.execute('''
        INSERT INTO cash_flows 
        SELECT * FROM cash_flows_temp
    ''')
    
    # Drop temp table
    cursor.execute('DROP TABLE cash_flows_temp')
    
    # Recreate indexes
    print("Recreating indexes...")
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_cash_flows_account ON cash_flows(account_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_cash_flows_type ON cash_flows(transaction_type)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_cash_flows_date ON cash_flows(transaction_date)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_cash_flows_account_date ON cash_flows(account_id, transaction_date)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_cash_flows_account_type ON cash_flows(account_id, transaction_type)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_cash_flows_ticker ON cash_flows(ticker_id)')
    
    conn.commit()
    conn.close()
    
    print("\nMigration completed!")
    print(f"Summary:")
    print(f"  - Updated {sell_updated} 'SELL' transactions")
    print(f"  - Updated {options_updated} 'OPTIONS' transactions")
    print(f"  - Updated CHECK constraint to new transaction types")

if __name__ == '__main__':
    print("Migrating cash_flows.transaction_type values...")
    migrate_transaction_types()
    print("Done!")

