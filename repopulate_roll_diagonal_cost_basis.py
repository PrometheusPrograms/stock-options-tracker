#!/usr/bin/env python3
"""
Repopulate cost basis table with diagonal entries for roll trades.

This script:
1. Finds all trades with status 'roll' that have child trades (via trade_parent_id)
2. For each child trade, checks if a diagonal cost basis entry exists
3. Creates diagonal cost basis entries if they don't exist
"""

import sqlite3
from datetime import datetime

def get_db_connection():
    """Get database connection"""
    conn = sqlite3.connect('trades.db')
    conn.row_factory = sqlite3.Row
    return conn

def create_roll_diagonal_cost_basis_entry(cursor, new_trade_id, original_trade_id, account_id, ticker_id, 
                                         date_trade_open, ticker, new_exp_date, original_exp_date,
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
            print(f"  Diagonal entry already exists for trade {new_trade_id}, skipping...")
            return False
        
        # Insert cost basis entry
        cursor.execute('''
            INSERT INTO cost_basis 
            (account_id, ticker_id, trade_id, cash_flow_id, transaction_date, description, shares, cost_per_share, 
             total_amount, running_basis, running_shares, basis_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, new_trade_id, None, date_trade_open, description, shares, cost_per_share,
              total_amount, new_running_basis, new_running_shares, basis_per_share))
        
        print(f"  Created diagonal entry for trade {new_trade_id}: {description}")
        return True
        
    except Exception as e:
        import traceback
        print(f"  Error creating diagonal entry for trade {new_trade_id}: {e}")
        print(f"  Traceback: {traceback.format_exc()}")
        return False

def main():
    """Main function to repopulate diagonal cost basis entries"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    print("Repopulating diagonal cost basis entries for roll trades...")
    print("=" * 60)
    
    # Find all trades with status 'roll' that have child trades
    # A roll trade has status 'roll' and child trades have trade_parent_id pointing to it
    cursor.execute('''
        SELECT DISTINCT
            parent.id as parent_id,
            parent.account_id as parent_account_id,
            parent.ticker_id as parent_ticker_id,
            parent.expiration_date as parent_exp_date,
            parent.strike_price as parent_strike,
            parent.trade_type as parent_trade_type,
            parent.num_of_contracts as parent_num_contracts,
            parent.date_trade_open as parent_date_trade_open,
            child.id as child_id,
            child.expiration_date as child_exp_date,
            child.strike_price as child_strike,
            child.credit_debit as child_credit,
            child.num_of_contracts as child_num_contracts,
            child.date_trade_open as child_date_trade_open,
            t.ticker
        FROM trades parent
        JOIN trades child ON child.trade_parent_id = parent.id
        JOIN tickers t ON parent.ticker_id = t.id
        WHERE parent.trade_status = 'roll'
        ORDER BY parent.id, child.id
    ''')
    
    roll_trades = cursor.fetchall()
    
    if not roll_trades:
        print("No roll trades with child trades found.")
        conn.close()
        return
    
    print(f"Found {len(roll_trades)} roll trade(s) with child trades")
    print()
    
    created_count = 0
    skipped_count = 0
    error_count = 0
    
    for row in roll_trades:
        parent_id = row['parent_id']
        child_id = row['child_id']
        account_id = row['parent_account_id']
        ticker_id = row['parent_ticker_id']
        ticker = row['ticker']
        
        parent_exp_date = row['parent_exp_date']
        parent_strike = row['parent_strike']
        parent_trade_type = row['parent_trade_type']
        parent_num_contracts = row['parent_num_contracts']
        parent_date_trade_open = row['parent_date_trade_open']
        
        child_exp_date = row['child_exp_date']
        child_strike = row['child_strike']
        child_credit = row['child_credit']
        child_num_contracts = row['child_num_contracts']
        child_date_trade_open = row['child_date_trade_open']
        
        print(f"Processing roll trade {parent_id} -> child trade {child_id}")
        print(f"  Ticker: {ticker}")
        print(f"  Parent: {parent_trade_type}, Exp: {parent_exp_date}, Strike: {parent_strike}")
        print(f"  Child: Exp: {child_exp_date}, Strike: {child_strike}, Credit: {child_credit}, Contracts: {child_num_contracts}")
        
        # Only create diagonal entry if child trade has valid values
        if not child_strike or child_strike == 0:
            print(f"  Skipping: Child trade {child_id} has no strike price")
            skipped_count += 1
            continue
        
        if not child_credit or child_credit == 0:
            print(f"  Skipping: Child trade {child_id} has no credit/debit")
            skipped_count += 1
            continue
        
        if not child_exp_date:
            print(f"  Skipping: Child trade {child_id} has no expiration date")
            skipped_count += 1
            continue
        
        # Create diagonal cost basis entry
        success = create_roll_diagonal_cost_basis_entry(
            cursor, child_id, parent_id, account_id, ticker_id,
            child_date_trade_open, ticker, child_exp_date, parent_exp_date,
            child_strike, parent_strike, child_credit, parent_trade_type, child_num_contracts
        )
        
        if success:
            created_count += 1
        elif success is False:
            skipped_count += 1
        else:
            error_count += 1
        
        print()
    
    # Commit all changes
    conn.commit()
    conn.close()
    
    print("=" * 60)
    print(f"Summary:")
    print(f"  Created: {created_count} diagonal entries")
    print(f"  Skipped: {skipped_count} (already exist or missing data)")
    print(f"  Errors: {error_count}")
    print("Done!")

if __name__ == '__main__':
    main()






