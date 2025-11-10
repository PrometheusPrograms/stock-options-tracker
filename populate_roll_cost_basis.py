#!/usr/bin/env python3
"""
Script to populate cost basis entries for existing trades with status 'roll'
"""

import sqlite3
from datetime import datetime

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def create_roll_diagonal_cost_basis_entry(cursor, new_trade_id, original_trade_id, account_id, ticker_id, 
                                         trade_date, ticker, new_exp_date, original_exp_date,
                                         new_strike, original_strike, new_credit, original_trade_type, new_num_contracts):
    """Create cost basis entry for roll trades with diagonal format"""
    try:
        # Format dates as DD-MMM-YY
        try:
            new_exp = datetime.strptime(new_exp_date, '%Y-%m-%d')
            new_exp_formatted = new_exp.strftime('%d-%b-%y').upper()
        except:
            new_exp_formatted = new_exp_date
        
        try:
            orig_exp = datetime.strptime(original_exp_date, '%Y-%m-%d')
            orig_exp_formatted = orig_exp.strftime('%d-%b-%y').upper()
        except:
            orig_exp_formatted = original_exp_date
        
        # Determine if it's PUT or CALL based on trade_type
        is_put = 'PUT' in original_trade_type or 'ROP' in original_trade_type
        is_call = 'CALL' in original_trade_type or 'ROC' in original_trade_type
        
        # Create description based on trade type
        if is_put:
            description = f"SELL -{new_num_contracts} DIAGONAL {ticker} 100 {new_exp_formatted}/{orig_exp_formatted} {new_strike}/{original_strike} PUT @ {new_credit}"
        elif is_call:
            description = f"SELL -{new_num_contracts} DIAGONAL {ticker} 100 {new_exp_formatted}/{orig_exp_formatted} {new_strike}/{original_strike} CALL @ {new_credit}"
        else:
            description = f"SELL -{new_num_contracts} DIAGONAL {ticker} 100 {new_exp_formatted}/{orig_exp_formatted} {new_strike}/{original_strike} {original_trade_type} @ {new_credit}"
        
        # For diagonal roll trades:
        # - shares = 0 (options trades)
        # - cost_per_share = 0
        # - total_amount = -new_credit * new_num_contracts * 100 (negative because we receive premium)
        shares = 0
        cost_per_share = 0
        total_amount = -(new_credit * new_num_contracts * 100)
        
        # Get current running totals for this account and ticker
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
        
        # Update running totals
        new_running_basis = running_basis + total_amount
        new_running_shares = running_shares + shares  # shares is 0 for options
        
        # Calculate basis per share
        basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
        
        # Check if entry already exists
        cursor.execute('''
            SELECT id FROM cost_basis 
            WHERE trade_id = ? AND description LIKE 'SELL -% DIAGONAL%'
        ''', (new_trade_id,))
        existing_entry = cursor.fetchone()
        
        if existing_entry:
            print(f"Cost basis entry already exists for trade {new_trade_id}, skipping...")
            return False
        
        # Insert cost basis entry
        cursor.execute('''
            INSERT INTO cost_basis 
            (account_id, ticker_id, trade_id, cash_flow_id, transaction_date, description, shares, cost_per_share, 
             total_amount, running_basis, running_shares, basis_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, new_trade_id, None, trade_date, description, shares, cost_per_share,
              total_amount, new_running_basis, new_running_shares, basis_per_share))
        
        print(f"Created roll diagonal cost basis entry for trade {new_trade_id}: {description}")
        return True
        
    except Exception as e:
        import traceback
        print(f"Error creating roll diagonal cost basis entry: {e}")
        print(f"Traceback: {traceback.format_exc()}")
        return False

def main():
    """Main function to populate cost basis entries for roll trades"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Find all trades with status 'roll'
    cursor.execute('''
        SELECT id, account_id, ticker_id, trade_date, expiration_date, strike_price, 
               trade_type, num_of_contracts, credit_debit
        FROM trades
        WHERE trade_status = 'roll'
    ''')
    
    roll_trades = cursor.fetchall()
    print(f"Found {len(roll_trades)} trades with status 'roll'")
    
    created_count = 0
    skipped_count = 0
    error_count = 0
    
    for roll_trade in roll_trades:
        roll_trade_id = roll_trade['id']
        account_id = roll_trade['account_id']
        ticker_id = roll_trade['ticker_id']
        original_exp_date = roll_trade['expiration_date']
        original_strike = roll_trade['strike_price']
        original_trade_type = roll_trade['trade_type']
        original_num_contracts = roll_trade['num_of_contracts']
        
        # Find the child trade (the one with trade_parent_id pointing to this roll trade)
        cursor.execute('''
            SELECT id, trade_date, expiration_date, strike_price, credit_debit, num_of_contracts
            FROM trades
            WHERE trade_parent_id = ?
        ''', (roll_trade_id,))
        
        child_trade = cursor.fetchone()
        
        if not child_trade:
            print(f"No child trade found for roll trade {roll_trade_id}, skipping...")
            skipped_count += 1
            continue
        
        # Get ticker symbol
        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
        ticker_row = cursor.fetchone()
        if not ticker_row:
            print(f"Ticker not found for ticker_id {ticker_id}, skipping trade {roll_trade_id}...")
            skipped_count += 1
            continue
        
        ticker = ticker_row['ticker']
        
        # Get values from child trade
        new_trade_id = child_trade['id']
        trade_date = child_trade['trade_date']
        new_exp_date = child_trade['expiration_date']
        new_strike = child_trade['strike_price']
        new_credit = child_trade['credit_debit']
        new_num_contracts = child_trade['num_of_contracts']
        
        # Only create if we have valid values
        if new_strike and new_strike > 0 and new_credit and new_credit != 0:
            success = create_roll_diagonal_cost_basis_entry(
                cursor, new_trade_id, roll_trade_id, account_id, ticker_id,
                trade_date, ticker, new_exp_date, original_exp_date,
                new_strike, original_strike, new_credit, original_trade_type, new_num_contracts
            )
            if success:
                created_count += 1
            else:
                skipped_count += 1
        else:
            print(f"Child trade {new_trade_id} has invalid values (strike: {new_strike}, credit: {new_credit}), skipping...")
            skipped_count += 1
    
    conn.commit()
    conn.close()
    
    print(f"\nSummary:")
    print(f"  Created: {created_count}")
    print(f"  Skipped: {skipped_count}")
    print(f"  Errors: {error_count}")

if __name__ == '__main__':
    main()


