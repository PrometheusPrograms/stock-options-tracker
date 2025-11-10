#!/usr/bin/env python3
"""
Script to create missing cash_flow entries for trades that don't have them.
This ensures every trade_id has a corresponding entry in the cash_flows table.
"""

import sqlite3
from datetime import datetime

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def create_missing_cash_flows():
    """Create cash_flow entries for trades that don't have them"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Find all trades without cash_flow entries
    cursor.execute('''
        SELECT t.id, t.account_id, t.ticker_id, t.trade_date, t.trade_type, 
               t.num_of_contracts, t.credit_debit, t.total_premium, t.trade_status,
               tt.requires_contracts
        FROM trades t
        LEFT JOIN cash_flows cf ON t.id = cf.trade_id
        LEFT JOIN trade_types tt ON t.trade_type_id = tt.id
        WHERE cf.id IS NULL
        ORDER BY t.id
    ''')
    
    trades_without_cash_flow = cursor.fetchall()
    
    print(f"Found {len(trades_without_cash_flow)} trades without cash_flow entries")
    
    created_count = 0
    linked_count = 0
    
    for trade in trades_without_cash_flow:
        trade_id = trade['id']
        account_id = trade['account_id']
        ticker_id = trade['ticker_id']
        trade_date = trade['trade_date']
        trade_type = trade['trade_type']
        num_of_contracts = trade['num_of_contracts']
        credit_debit = trade['credit_debit']
        total_premium = trade['total_premium']
        trade_status = trade['trade_status']
        requires_contracts = trade['requires_contracts'] if trade['requires_contracts'] is not None else 0
        
        # Skip assigned trades - they should have ASSIGNMENT cash flows created separately
        if trade_status == 'assigned':
            print(f"Skipping trade {trade_id} (status: assigned) - should have ASSIGNMENT cash flow")
            continue
        
        cash_flow_id = None
        
        if requires_contracts == 1:
            # Options trade: determine if PUT or CALL
            if 'PUT' in trade_type or 'ROP' in trade_type:
                transaction_type = 'SELL PUT'
            elif 'CALL' in trade_type or 'ROC' in trade_type:
                transaction_type = 'SELL CALL'
            else:
                # Default to PREMIUM_CREDIT if can't determine
                transaction_type = 'PREMIUM_CREDIT'
            amount = credit_debit * num_of_contracts * 100
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, trade_date, transaction_type, round(amount, 2), 
                  f"{trade_type} premium received", trade_id, ticker_id))
            cash_flow_id = cursor.lastrowid
        else:
            # For BTO/STC or other trade types that don't require contracts
            # These are stock trades, use PREMIUM_CREDIT or PREMIUM_DEBIT
            if trade_type == 'BTO':
                transaction_type = 'PREMIUM_DEBIT'  # Buying stock
            else:
                transaction_type = 'PREMIUM_CREDIT'  # Selling stock
            amount = total_premium if total_premium is not None else (credit_debit * num_of_contracts)
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, trade_date, transaction_type, round(amount, 2), 
                  f"{trade_type} {num_of_contracts} shares", trade_id, ticker_id))
            cash_flow_id = cursor.lastrowid
        
        # Update cost_basis entry to link to cash_flow if cash flow was created
        if cash_flow_id:
            cursor.execute('''
                UPDATE cost_basis SET cash_flow_id = ? 
                WHERE trade_id = ? AND ticker_id = ? AND transaction_date = ? AND cash_flow_id IS NULL
            ''', (cash_flow_id, trade_id, ticker_id, trade_date))
            linked_count += cursor.rowcount
        
        created_count += 1
        print(f"Created cash_flow {cash_flow_id} for trade {trade_id} ({trade_type})")
    
    conn.commit()
    conn.close()
    
    print(f"\nCompleted: Created {created_count} cash_flow entries and linked {linked_count} cost_basis entries")
    return created_count

if __name__ == '__main__':
    print("Creating missing cash_flow entries for trades...")
    create_missing_cash_flows()
    print("Done!")

