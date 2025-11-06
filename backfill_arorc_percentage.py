#!/usr/bin/env python3
"""
Backfill ARORC values using corrected formula.
ARORC should be stored as a percentage (100 = 100%), not as a decimal.
This script recalculates ARORC for all ROCT PUT and RULE ONE PUT trades
using the corrected formula with unrounded risk_capital_per_share.
"""

import sqlite3
from decimal import Decimal, ROUND_HALF_UP

def round_standard(value, decimals=1):
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
        SELECT t.id, t.trade_type, t.strike_price, t.credit_debit, 
               t.commission_per_share, t.days_to_expiration, t.margin_percent, t.ARORC,
               tk.ticker
        FROM trades t
        JOIN tickers tk ON t.ticker_id = tk.id
        WHERE (t.trade_type LIKE '%ROCT PUT%' OR t.trade_type LIKE '%RULE ONE PUT%' OR
               (t.trade_type LIKE '%PUT%' AND (t.trade_type LIKE '%ROCT%' OR t.trade_type LIKE '%RULE ONE%')))
          AND t.strike_price > 0
          AND t.credit_debit IS NOT NULL
          AND t.days_to_expiration > 0
    ''')
    
    trades = cursor.fetchall()
    updated_count = 0
    
    print(f"Found {len(trades)} ROCT PUT and RULE ONE PUT trades to update...", flush=True)
    
    for trade in trades:
        trade_id = trade['id']
        trade_type = trade['trade_type']
        strike_price = float(trade['strike_price'])
        credit_debit = float(trade['credit_debit'])
        commission_per_share = float(trade['commission_per_share'] or 0)
        days_to_expiration = trade['days_to_expiration']
        margin_percent = float(trade['margin_percent'] or 100.0)
        old_arorc = trade['ARORC']
        ticker = trade['ticker']
        
        # Recalculate unrounded net_credit_per_share
        net_credit_per_share = credit_debit - commission_per_share
        
        # Calculate unrounded risk_capital_per_share
        risk_capital_unrounded = strike_price - net_credit_per_share
        
        # Calculate ARORC using corrected formula
        # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
        denominator = risk_capital_unrounded * (margin_percent / 100.0)
        
        if denominator > 0 and risk_capital_unrounded > 0 and days_to_expiration > 0 and margin_percent > 0:
            # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
            arorc_decimal = (365.0 / days_to_expiration) * (net_credit_per_share / denominator)
            new_arorc = round_standard(arorc_decimal * 100.0, 1)
            
            # Update only if the value changed
            if old_arorc is None or abs(old_arorc - new_arorc) > 0.01:
                cursor.execute('UPDATE trades SET ARORC = ? WHERE id = ?', (new_arorc, trade_id))
                updated_count += 1
                print(f"  Trade {trade_id} ({ticker}): ARORC updated from {old_arorc} to {new_arorc}%")
    
    conn.commit()
    conn.close()
    print(f"\nBackfill complete. Updated {updated_count} trades.")

if __name__ == '__main__':
    main()
