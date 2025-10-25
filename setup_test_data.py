#!/usr/bin/env python3
"""
Setup script to initialize database with test data for PythonAnywhere deployment
Only initializes if database is empty or doesn't exist
"""

import sqlite3
import os

def setup_test_data():
    """Initialize database with test data only if database is empty"""
    
    # Database file path
    db_path = 'trades.db'
    
    # Check if database exists and has data
    if os.path.exists(db_path):
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Check if trades table exists and has data
        try:
            cursor.execute("SELECT COUNT(*) FROM trades")
            count = cursor.fetchone()[0]
            conn.close()
            
            if count > 0:
                print(f"⚠️  Database already contains {count} trades")
                print("🛡️  Skipping test data setup to protect existing data")
                print("💡 To force setup, delete trades.db first")
                return False
        except sqlite3.OperationalError:
            # Table doesn't exist, safe to proceed
            conn.close()
            print("📊 No trades table found, proceeding with setup")
    
    # Create new database or initialize empty one
    if os.path.exists(db_path):
        os.remove(db_path)
        print(f"🗑️  Removed existing empty database: {db_path}")
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Create trades table
    cursor.execute('''
        CREATE TABLE trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            expiration_date TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            premium REAL NOT NULL,
            total_premium REAL NOT NULL,
            days_to_expiration INTEGER NOT NULL,
            current_price REAL NOT NULL,
            strike_price REAL DEFAULT 0,
            status TEXT DEFAULT 'open',
            trade_type TEXT DEFAULT 'ROCT PUT',
            shares INTEGER DEFAULT 0,
            cost_per_share REAL DEFAULT 0,
            total_cost REAL DEFAULT 0,
            closing_amount REAL DEFAULT 0,
            transaction_type TEXT DEFAULT 'sell',
            trade_description TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Insert test data
    test_trades = [
        # Options trades
        ('AAPL', '2024-10-24', '2024-11-15', 1, 2.50, 250.0, 22, 175.50, 180.0, 'open', 'ROCT PUT', 100, 0),
        ('TSLA', '2024-10-23', '2024-11-22', 2, 1.75, 350.0, 29, 245.30, 250.0, 'open', 'ROCT CALL', 200, 0),
        ('MSFT', '2024-10-22', '2024-12-20', 1, 3.20, 320.0, 57, 420.15, 425.0, 'expired', 'ROCT PUT', 100, 0),
        ('GOOGL', '2024-10-21', '2024-11-29', 3, 1.40, 420.0, 36, 135.80, 140.0, 'assigned', 'ROCT CALL', 300, 0),
        ('NVDA', '2024-10-20', '2024-12-13', 2, 4.50, 900.0, 50, 850.25, 860.0, 'closed', 'ROCT PUT', 200, 0),
        ('AMZN', '2024-10-19', '2024-11-08', 1, 2.80, 280.0, 15, 155.40, 160.0, 'open', 'ROCT CALL', 100, 0),
        ('META', '2024-10-18', '2024-12-06', 2, 3.75, 750.0, 43, 380.90, 385.0, 'assigned', 'ROCT PUT', 200, 0),
        ('NFLX', '2024-10-17', '2024-11-15', 1, 1.90, 190.0, 22, 485.60, 490.0, 'closed', 'ROCT CALL', 100, 0),
        
        # Stock transactions
        ('AAPL', '2024-10-15', '2024-10-15', 10, 0, 0, 0, 175.50, 175.50, 'open', 'BTO', 10, 175.50),
        ('AAPL', '2024-10-20', '2024-10-20', 5, 0, 0, 0, 180.25, 180.25, 'open', 'STC', 5, 180.25),
        ('TSLA', '2024-10-10', '2024-10-10', 20, 0, 0, 0, 240.80, 240.80, 'open', 'BTO', 20, 240.80),
    ]
    
    cursor.executemany('''
        INSERT INTO trades (ticker, trade_date, expiration_date, quantity, premium, total_premium, 
                          days_to_expiration, current_price, strike_price, status, trade_type, shares, cost_per_share)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', test_trades)
    
    conn.commit()
    conn.close()
    
    print(f"✅ Database initialized with {len(test_trades)} test trades")
    print("📊 Test data includes:")
    print("   - 8 Options trades (ROCT PUT/CALL)")
    print("   - 3 Stock transactions (BTO/STC)")
    print("   - Various statuses: open, closed, expired, assigned")
    print("   - Multiple tickers: AAPL, TSLA, MSFT, GOOGL, NVDA, AMZN, META, NFLX")
    return True

if __name__ == '__main__':
    setup_test_data()
