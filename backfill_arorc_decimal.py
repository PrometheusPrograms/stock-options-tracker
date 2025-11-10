#!/usr/bin/env python3
"""
Backfill ARORC values from percentage to decimal format.
This script converts existing ARORC values from percentage (e.g., 20.0 = 20%) 
to decimal format (e.g., 0.2 = 20%) by dividing by 100 if the value is > 1.
"""

import sqlite3
from decimal import Decimal, ROUND_HALF_UP

def round_standard(value, decimals=4):
    """Round to nearest value, always rounding 0.5 up (standard rounding)"""
    if value is None:
        return None
    return float(Decimal(str(value)).quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP))

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def main():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Get all trades with ARORC values
    cursor.execute('''
        SELECT t.id, t.ARORC, tk.ticker
        FROM trades t
        LEFT JOIN tickers tk ON t.ticker_id = tk.id
        WHERE t.ARORC IS NOT NULL
        ORDER BY t.id
    ''')
    
    trades = cursor.fetchall()
    print(f"Found {len(trades)} trades with ARORC values")
    
    updated_count = 0
    for trade in trades:
        trade_id = trade['id']
        current_arorc = trade['ARORC']
        ticker = trade['ticker'] or 'UNKNOWN'
        
        # Convert from percentage to decimal if value > 1
        if current_arorc is not None:
            if current_arorc > 1.0:
                # Value is in percentage format, convert to decimal
                new_arorc = round_standard(current_arorc / 100.0, 4)
                print(f"  Trade {trade_id} ({ticker}): {current_arorc}% -> {new_arorc} ({new_arorc * 100}%)")
            else:
                # Value is already in decimal format (or very small), keep as is
                new_arorc = round_standard(current_arorc, 4)
                if abs(current_arorc - new_arorc) > 0.0001:
                    print(f"  Trade {trade_id} ({ticker}): {current_arorc} -> {new_arorc} (rounded)")
                else:
                    # Value unchanged
                    continue
            
            # Update the trade
            cursor.execute('UPDATE trades SET ARORC = ? WHERE id = ?', (new_arorc, trade_id))
            updated_count += 1
    
    conn.commit()
    conn.close()
    
    print(f"\n✓ Updated {updated_count} trades")
    print("ARORC values are now stored as decimals (0.2 = 20%)")

if __name__ == '__main__':
    main()



