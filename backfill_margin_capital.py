#!/usr/bin/env python3
"""
Backfill margin_capital values using unrounded risk_capital_per_share.
This script recalculates margin_capital for all ROCT PUT and RULE ONE PUT trades
using the unrounded risk_capital_per_share value.
"""

import sqlite3
from decimal import Decimal, ROUND_HALF_UP

def round_standard(value, decimals=2):
    """Round to nearest value, always rounding 0.5 up (standard rounding)"""
    if value is None:
        return None
    quantize_str = '1.' + '0' * decimals
    return float(Decimal(str(value)).quantize(Decimal(quantize_str), rounding=ROUND_HALF_UP))

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def main():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Get all ROCT PUT and RULE ONE PUT trades
    cursor.execute('''
        SELECT t.id, t.trade_type, t.num_of_contracts, t.strike_price, 
               t.credit_debit, t.commission_per_share, t.net_credit_per_share, 
               t.risk_capital_per_share, t.margin_capital, tk.ticker
        FROM trades t
        JOIN tickers tk ON t.ticker_id = tk.id
        WHERE (t.trade_type LIKE '%ROCT PUT%' OR t.trade_type LIKE '%RULE ONE PUT%' OR
               (t.trade_type LIKE '%PUT%' AND (t.trade_type LIKE '%ROCT%' OR t.trade_type LIKE '%RULE ONE%')))
          AND t.strike_price > 0
          AND t.credit_debit IS NOT NULL
    ''')
    
    trades = cursor.fetchall()
    updated_count = 0
    
    print(f"Found {len(trades)} ROCT PUT and RULE ONE PUT trades to update...", flush=True)
    
    for trade in trades:
        trade_id = trade['id']
        trade_type = trade['trade_type']
        num_of_contracts = trade['num_of_contracts']
        strike_price = float(trade['strike_price'])
        credit_debit = float(trade['credit_debit'])
        commission_per_share = float(trade['commission_per_share'] or 0)
        old_margin_capital = trade['margin_capital']
        ticker = trade['ticker']
        
        # Recalculate unrounded net_credit_per_share
        net_credit_per_share_unrounded = credit_debit - commission_per_share
        
        # Calculate unrounded risk_capital_per_share
        risk_capital_unrounded = strike_price - net_credit_per_share_unrounded
        
        # Calculate new margin_capital using unrounded value
        new_margin_capital = num_of_contracts * 100 * risk_capital_unrounded
        
        # Update only if the value changed
        if abs(old_margin_capital - new_margin_capital) > 0.01:
            cursor.execute('UPDATE trades SET margin_capital = ? WHERE id = ?', (new_margin_capital, trade_id))
            updated_count += 1
            print(f"  Trade {trade_id} ({ticker}): margin_capital updated from {old_margin_capital:.2f} to {new_margin_capital:.2f}")
    
    conn.commit()
    conn.close()
    print(f"\nBackfill complete. Updated {updated_count} trades.")

if __name__ == '__main__':
    main()

