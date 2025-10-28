#!/usr/bin/env python3
"""
Script to update the database schema and repopulate cash_flows and cost_basis tables
Run this on PythonAnywhere after pulling the latest code
"""

import sqlite3
from app import get_db_connection
import requests

def update_database_schema():
    """Update the database schema with new transaction types"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        print("Checking database schema...")
        
        # Check if cash_flows table needs to be updated
        cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='cash_flows';")
        schema = cursor.fetchone()
        
        if schema and 'ASSIGNMENT' not in schema[0]:
            print("Updating cash_flows table schema...")
            
            # Get existing data
            cursor.execute('SELECT * FROM cash_flows')
            existing_data = [dict(row) for row in cursor.fetchall()]
            
            # Drop and recreate with new schema
            cursor.execute('DROP TABLE cash_flows')
            
            # Create new table with ASSIGNMENT support
            cursor.execute('''
                CREATE TABLE cash_flows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    transaction_date TEXT NOT NULL,
                    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'OPTIONS', 'ASSIGNMENT', 'BUY', 'SELL')),
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
            
            # Restore existing data
            for row_dict in existing_data:
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    row_dict['account_id'],
                    row_dict['transaction_date'],
                    row_dict['transaction_type'],
                    row_dict['amount'],
                    row_dict.get('description'),
                    row_dict.get('trade_id'),
                    row_dict.get('ticker_id'),
                    row_dict.get('created_at')
                ))
            
            conn.commit()
            print("✓ Cash_flows table updated")
        else:
            print("✓ Cash_flows table already up to date")
        
        conn.close()
        
    except Exception as e:
        print(f"Error updating schema: {e}")
        raise

def repopulate_cash_flows():
    """Call the repopulate endpoint to rebuild cash_flows"""
    try:
        print("\nRepopulating cash_flows table...")
        response = requests.post('http://prometheusprograms.pythonanywhere.com/api/repopulate-cash-flows')
        if response.status_code == 200:
            print(f"✓ {response.json()['message']}")
        else:
            print(f"✗ Error: {response.json()}")
    except Exception as e:
        print(f"✗ Error repopulating cash_flows: {e}")

def repopulate_cost_basis():
    """Call the repopulate endpoint to rebuild cost_basis links"""
    try:
        print("\nRepopulating cost_basis links...")
        response = requests.post('http://prometheusprograms.pythonanywhere.com/api/repopulate-cost-basis')
        if response.status_code == 200:
            print(f"✓ {response.json()['message']}")
        else:
            print(f"✗ Error: {response.json()}")
    except Exception as e:
        print(f"✗ Error repopulating cost_basis: {e}")

if __name__ == '__main__':
    print("=" * 60)
    print("PythonAnywhere Database Update Script")
    print("=" * 60)
    
    print("\n1. Updating database schema...")
    update_database_schema()
    
    print("\n2. Repopulating cash_flows...")
    repopulate_cash_flows()
    
    print("\n3. Repopulating cost_basis links...")
    repopulate_cost_basis()
    
    print("\n" + "=" * 60)
    print("✓ Database update complete!")
    print("=" * 60)

