"""
Backfill script to round strike_price values to 2 decimal places using round_standard
This ensures all values are rounded consistently using standard rounding (always round 0.5 up)
"""
import sqlite3
from decimal import Decimal, ROUND_HALF_UP
import sys
import os

# Add parent directory to path to import round_standard
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DATABASE = 'trades.db'

def round_standard(value, decimals=2):
    """Round to nearest value, always rounding 0.5 up (standard rounding)"""
    if value is None:
        return None
    return float(Decimal(str(value)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))

def get_db_connection():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def backfill_strike_price():
    conn = get_db_connection()
    cursor = conn.cursor()

    # Get all trades with strike_price values
    cursor.execute('SELECT id, strike_price FROM trades WHERE strike_price IS NOT NULL')
    trades = cursor.fetchall()
    updated_count = 0

    print(f"Found {len(trades)} trades with strike_price values to update")

    for trade in trades:
        trade_id = trade['id']
        strike_price = trade['strike_price']
        
        # Round strike_price to 2 decimal places using round_standard
        rounded_strike = round_standard(strike_price, 2)
        
        # Always update to ensure proper precision (e.g., 70.0 -> 70.00)
        cursor.execute('UPDATE trades SET strike_price = ? WHERE id = ?', (rounded_strike, trade_id))
        updated_count += 1
        if abs(strike_price - rounded_strike) > 0.0001:
            print(f"  Trade {trade_id}: {strike_price} -> {rounded_strike}")

    conn.commit()
    conn.close()

    print(f"\nUpdated {len(trades)} trades with properly rounded strike_price values")
    print("Examples:")
    print(f"  70.0 -> {round_standard(70.0, 2)}")
    print(f"  70.5 -> {round_standard(70.5, 2)}")
    print(f"  70.555 -> {round_standard(70.555, 2)}")

if __name__ == '__main__':
    backfill_strike_price()

