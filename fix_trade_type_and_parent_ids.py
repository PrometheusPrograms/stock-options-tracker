#!/usr/bin/env python3
"""
Script to fix trade_type_id and trade_parent_id for existing trades.
- Sets trade_type_id based on trade_type
- Sets trade_parent_id for trades with trade_status='roll'
"""

import sqlite3

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def fix_trade_type_and_parent_ids():
    """Fix trade_type_id and trade_parent_id for existing trades"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Fix trade_type_id
    print("Fixing trade_type_id...")
    cursor.execute('''
        SELECT id, trade_type FROM trades WHERE trade_type_id IS NULL
    ''')
    trades_without_type_id = cursor.fetchall()
    
    fixed_type_id_count = 0
    for trade in trades_without_type_id:
        trade_id = trade['id']
        trade_type = trade['trade_type']
        
        # First try the full trade_type as-is
        cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (trade_type,))
        trade_type_row = cursor.fetchone()
        trade_type_id = trade_type_row['id'] if trade_type_row else None
        
        # If not found, try extracting base trade type (remove ticker prefix if present)
        if trade_type_id is None and ' ' in trade_type:
            parts = trade_type.split(' ', 1)
            if len(parts) == 2 and len(parts[0]) <= 5 and parts[0].isupper():
                base_trade_type = parts[1]  # Use the part after the ticker
                cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (base_trade_type,))
                trade_type_row = cursor.fetchone()
                trade_type_id = trade_type_row['id'] if trade_type_row else None
        
        if trade_type_id:
            cursor.execute('UPDATE trades SET trade_type_id = ? WHERE id = ?', (trade_type_id, trade_id))
            fixed_type_id_count += 1
            print(f"  Fixed trade {trade_id}: '{trade_type}' -> trade_type_id={trade_type_id}")
        else:
            print(f"  WARNING: trade_type_id not found for trade {trade_id}: '{trade_type}'")
    
    # Fix trade_parent_id for trades with trade_status='roll'
    print("\nFixing trade_parent_id for trades with trade_status='roll'...")
    
    # Get all trades with status='roll' that don't have a parent
    cursor.execute('''
        SELECT id, account_id, ticker_id, trade_date, trade_type
        FROM trades
        WHERE trade_status = 'roll' AND trade_parent_id IS NULL
        ORDER BY account_id, ticker_id, trade_date
    ''')
    roll_trades_without_parent = cursor.fetchall()
    
    fixed_parent_id_count = 0
    for roll_trade in roll_trades_without_parent:
        roll_trade_id = roll_trade['id']
        account_id = roll_trade['account_id']
        ticker_id = roll_trade['ticker_id']
        trade_date = roll_trade['trade_date']
        
        # Find the most recent trade with the same account and ticker that is NOT a roll trade
        # or is a roll trade but has a parent (i.e., the original trade)
        cursor.execute('''
            SELECT id FROM trades
            WHERE account_id = ? AND ticker_id = ? 
            AND id != ?
            AND (
                trade_status != 'roll' 
                OR (trade_status = 'roll' AND trade_parent_id IS NOT NULL)
            )
            AND trade_date <= ?
            ORDER BY trade_date DESC, id DESC
            LIMIT 1
        ''', (account_id, ticker_id, roll_trade_id, trade_date))
        
        parent_trade = cursor.fetchone()
        
        if parent_trade:
            parent_trade_id = parent_trade['id']
            cursor.execute('UPDATE trades SET trade_parent_id = ? WHERE id = ?', (parent_trade_id, roll_trade_id))
            fixed_parent_id_count += 1
            print(f"  Fixed trade {roll_trade_id}: set trade_parent_id={parent_trade_id}")
        else:
            print(f"  WARNING: Could not find parent trade for roll trade {roll_trade_id} (account={account_id}, ticker_id={ticker_id}, date={trade_date})")
    
    conn.commit()
    conn.close()
    
    print(f"\nCompleted:")
    print(f"  - Fixed {fixed_type_id_count} trades with trade_type_id")
    print(f"  - Fixed {fixed_parent_id_count} roll trades with trade_parent_id")

if __name__ == '__main__':
    print("Fixing trade_type_id and trade_parent_id for existing trades...")
    fix_trade_type_and_parent_ids()
    print("Done!")

