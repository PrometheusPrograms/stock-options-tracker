#!/usr/bin/env python3
"""Script to clear cash_flows, trades, and cost_basis tables"""

import sqlite3
import os

def get_db_connection():
    """Get database connection"""
    db_path = os.path.join(os.path.dirname(__file__), 'trades.db')
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def clear_tables():
    """Clear cash_flows, trades, and cost_basis tables"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Disable foreign key checks temporarily
        cursor.execute('PRAGMA foreign_keys = OFF')
        
        # Clear tables in order (respecting foreign key constraints)
        # cost_basis references trades and cash_flows, so clear it first
        cursor.execute('DELETE FROM cost_basis')
        print(f"Cleared cost_basis: {cursor.rowcount} rows deleted")
        
        # cash_flows references trades, so clear it next
        cursor.execute('DELETE FROM cash_flows')
        print(f"Cleared cash_flows: {cursor.rowcount} rows deleted")
        
        # trades is referenced by others, so clear it last
        cursor.execute('DELETE FROM trades')
        print(f"Cleared trades: {cursor.rowcount} rows deleted")
        
        # Re-enable foreign key checks
        cursor.execute('PRAGMA foreign_keys = ON')
        
        # Commit changes
        conn.commit()
        print("\nAll tables cleared successfully!")
        
    except Exception as e:
        conn.rollback()
        print(f"Error clearing tables: {e}")
        raise
    finally:
        conn.close()

if __name__ == '__main__':
    print("Clearing cash_flows, trades, and cost_basis tables...")
    clear_tables()

