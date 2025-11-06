#!/usr/bin/env python3
"""
Backfill script to round net_credit_per_share and risk_capital_per_share 
to 2 decimal places using standard rounding (always round 0.5 up)
"""
import sqlite3
from decimal import Decimal, ROUND_HALF_UP

def round_standard(value, decimals=2):
    """Round to nearest value, always rounding 0.5 up (standard rounding)"""
    if value is None:
        return None
    return float(Decimal(str(value)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))

def main():
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get all trades with net_credit_per_share or risk_capital_per_share
    cursor.execute('''
        SELECT id, net_credit_per_share, risk_capital_per_share
        FROM trades
        WHERE net_credit_per_share IS NOT NULL OR risk_capital_per_share IS NOT NULL
    ''')
    
    trades = cursor.fetchall()
    updated_count = 0
    
    print(f"Found {len(trades)} trades to update")
    
    for trade in trades:
        trade_id = trade['id']
        updates = []
        params = []
        
        # Round net_credit_per_share (always update to ensure correct rounding)
        if trade['net_credit_per_share'] is not None:
            rounded_net_credit = round_standard(trade['net_credit_per_share'], 2)
            updates.append('net_credit_per_share = ?')
            params.append(rounded_net_credit)
        
        # Round risk_capital_per_share (always update to ensure correct rounding)
        if trade['risk_capital_per_share'] is not None:
            rounded_risk_capital = round_standard(trade['risk_capital_per_share'], 2)
            updates.append('risk_capital_per_share = ?')
            params.append(rounded_risk_capital)
        
        # Update all trades
        if updates:
            params.append(trade_id)
            query = f"UPDATE trades SET {', '.join(updates)} WHERE id = ?"
            cursor.execute(query, params)
            updated_count += 1
    
    conn.commit()
    conn.close()
    
    print(f"Updated {updated_count} trades with properly rounded values")
    print("Examples:")
    print(f"  69.835 -> {round_standard(69.835, 2)}")
    print(f"  0.115 -> {round_standard(0.115, 2)}")
    print(f"  0.114 -> {round_standard(0.114, 2)}")
    print(f"  33.895 -> {round_standard(33.895, 2)}")
    print(f"  26.385 -> {round_standard(26.385, 2)}")

if __name__ == '__main__':
    main()

