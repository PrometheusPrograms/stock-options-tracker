#!/usr/bin/env python3
"""
Script to create missing cost basis entries for trades with status 'assigned'
"""

import sqlite3
from datetime import datetime

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def create_assigned_cost_basis_entry(cursor, trade):
    """Create cost basis entry for assigned trades"""
    try:
        trade_dict = dict(trade) if isinstance(trade, sqlite3.Row) else trade
        account_id = trade_dict.get('account_id', 9)
        ticker_id = trade_dict['ticker_id']
        trade_id = trade_dict['id']
        trade_date = trade_dict['trade_date']
        trade_type = trade_dict['trade_type']
        num_of_contracts = trade_dict['num_of_contracts']
        strike_price = trade_dict['strike_price']
        
        # Check if an assigned cost basis entry already exists for this trade
        cursor.execute('''
            SELECT COUNT(*) as count FROM cost_basis
            WHERE trade_id = ? AND account_id = ? AND ticker_id = ?
            AND description LIKE 'ASSIGNED%'
        ''', (trade_id, account_id, ticker_id))
        existing_count = cursor.fetchone()['count']
        
        if existing_count > 0:
            print(f"Assigned cost basis entry already exists for trade {trade_id}, skipping creation")
            return False
        
        # Get current running totals BEFORE creating the assigned entry
        cursor.execute('''
            SELECT running_basis, running_shares 
            FROM cost_basis 
            WHERE ticker_id = ? AND account_id = ?
            ORDER BY transaction_date DESC, rowid DESC 
            LIMIT 1
        ''', (ticker_id, account_id))
        
        last_entry = cursor.fetchone()
        if last_entry:
            running_basis = last_entry['running_basis']
            running_shares = last_entry['running_shares']
        else:
            running_basis = 0
            running_shares = 0
        
        # Get ticker for description
        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
        ticker_row = cursor.fetchone()
        if not ticker_row:
            print(f"Ticker not found for ticker_id {ticker_id}, skipping trade {trade_id}...")
            return False
        
        ticker = ticker_row['ticker']
        
        # Use expiration date as the transaction date for assigned trades
        assigned_trade_date = trade_dict['expiration_date']
        
        # Format expiration date
        try:
            exp_date = datetime.strptime(trade_dict['expiration_date'], '%Y-%m-%d').strftime('%d-%b-%y').upper()
        except:
            exp_date = trade_dict['expiration_date']
        
        # Calculate shares: num_of_contracts is in contracts, so multiply by 100
        num_shares = num_of_contracts * 100
        
        # Determine if this is a PUT or CALL based on trade type
        is_put = 'PUT' in trade_type.upper() or 'ROP' in trade_type.upper()
        
        # Create description as "ASSIGNED " + exp date + trade type
        if is_put:
            description = f"ASSIGNED {exp_date} PUT"
            shares = num_shares  # Positive for bought shares
            cost_per_share = strike_price
            total_amount = strike_price * shares
        else:  # CALL
            description = f"ASSIGNED {exp_date} CALL"
            shares = -num_shares  # Negative for sold shares
            cost_per_share = strike_price
            total_amount = -(strike_price * num_shares)  # Make negative for sold
        
        # Update running totals
        new_running_basis = running_basis + total_amount
        new_running_shares = running_shares + shares
        
        # Calculate basis per share
        basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
        
        # Insert cost basis entry (use expiration_date as transaction_date for assigned trades)
        cursor.execute('''
            INSERT INTO cost_basis 
            (account_id, ticker_id, trade_id, cash_flow_id, transaction_date, description, shares, cost_per_share, 
             total_amount, running_basis, running_shares, basis_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, trade_id, None, assigned_trade_date, description, shares, cost_per_share,
              total_amount, new_running_basis, new_running_shares, basis_per_share))
        
        print(f"Created assigned cost basis entry for trade {trade_id}: {description}")
        return True
        
    except Exception as e:
        import traceback
        print(f"Error creating assigned cost basis entry for trade {trade_dict.get('id', 'unknown')}: {e}")
        print(f"Traceback: {traceback.format_exc()}")
        return False

def main():
    """Main function to create missing assigned cost basis entries"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Find all trades with status 'assigned' that don't have an assigned cost basis entry
    cursor.execute('''
        SELECT t.*, tk.ticker
        FROM trades t
        JOIN tickers tk ON t.ticker_id = tk.id
        WHERE t.trade_status = 'assigned'
        AND NOT EXISTS (
            SELECT 1 FROM cost_basis cb
            WHERE cb.trade_id = t.id
            AND cb.description LIKE 'ASSIGNED%'
        )
    ''')
    
    assigned_trades = cursor.fetchall()
    print(f"Found {len(assigned_trades)} trades with status 'assigned' missing cost basis entries")
    
    created_count = 0
    error_count = 0
    
    for trade in assigned_trades:
        ticker = trade['ticker']
        trade_id = trade['id']
        print(f"\nProcessing trade {trade_id} ({ticker})...")
        
        success = create_assigned_cost_basis_entry(cursor, trade)
        if success:
            created_count += 1
        else:
            error_count += 1
    
    conn.commit()
    conn.close()
    
    print(f"\nSummary:")
    print(f"  Created: {created_count}")
    print(f"  Errors: {error_count}")

if __name__ == '__main__':
    main()

