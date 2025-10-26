from flask import Flask, render_template, request, jsonify
import sqlite3
import os
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = Flask(__name__)

# Database configuration
DATABASE = 'trades.db'

def get_db_connection():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initialize database with new structure"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Create accounts table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_name TEXT UNIQUE NOT NULL,
            account_type TEXT DEFAULT 'PRIMARY',
            start_date TEXT,
            starting_balance REAL DEFAULT 0.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Insert default accounts if they don't exist
    cursor.execute('''
        INSERT OR IGNORE INTO accounts (account_name, account_type) 
        VALUES ('Rule One', 'INVESTMENT')
    ''')
    
    # Delete any "Main Account" entries
    cursor.execute('DELETE FROM accounts WHERE account_name = "Main Account"')
    
    # Create tickers table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tickers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT UNIQUE NOT NULL,
            company_name TEXT NOT NULL,
            sector TEXT,
            market_cap REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Create trades table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER DEFAULT 9,
            ticker_id INTEGER NOT NULL,
            trade_date TEXT NOT NULL,
            expiration_date TEXT NOT NULL,
            num_of_contracts INTEGER NOT NULL,
            premium REAL NOT NULL,
            total_premium REAL NOT NULL,
            days_to_expiration INTEGER NOT NULL,
            current_price REAL NOT NULL,
            strike_price REAL NOT NULL,
            status TEXT DEFAULT 'open',
            trade_type TEXT NOT NULL,
            commission REAL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            price_per_share REAL DEFAULT 0,
            total_amount REAL DEFAULT 0,
            FOREIGN KEY (ticker_id) REFERENCES tickers(id),
            FOREIGN KEY (account_id) REFERENCES accounts(id)
        )
    ''')
    
    # Create cost_basis table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cost_basis (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER DEFAULT 9,
            ticker_id INTEGER NOT NULL,
            trade_id INTEGER,
            transaction_date TEXT NOT NULL,
            description TEXT NOT NULL,
            shares INTEGER NOT NULL,
            cost_per_share REAL NOT NULL,
            total_amount REAL NOT NULL,
            running_basis REAL NOT NULL,
            running_shares INTEGER NOT NULL,
            basis_per_share REAL NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id),
            FOREIGN KEY (ticker_id) REFERENCES tickers(id),
            FOREIGN KEY (trade_id) REFERENCES trades(id)
        )
    ''')
    
    # Create trade_status_history table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trade_status_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id INTEGER NOT NULL,
            old_status TEXT,
            new_status TEXT NOT NULL,
            changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (trade_id) REFERENCES trades(id)
        )
    ''')
    
    # Create bankroll table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS bankroll (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_date TEXT NOT NULL,
            transaction_amount REAL NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Create cash_flows table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cash_flows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT')),
            amount NUMERIC(12,2) NOT NULL,
            description TEXT,
            trade_id INTEGER,
            ticker_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id),
            FOREIGN KEY (trade_id) REFERENCES trades(id),
            FOREIGN KEY (ticker_id) REFERENCES tickers(id)
        )
    ''')
    
    conn.commit()
    conn.close()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/accounts', methods=['GET'])
def get_accounts():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM accounts ORDER BY account_name')
        accounts = cursor.fetchall()
        conn.close()
        return jsonify([dict(a) for a in accounts])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/accounts', methods=['POST'])
def create_account():
    try:
        data = request.get_json()
        account_name = data.get('account_name')
        account_type = data.get('account_type', 'PRIMARY')
        start_date = data.get('start_date')
        starting_balance = data.get('starting_balance', 0.0)
        
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO accounts (account_name, account_type, start_date, starting_balance) 
            VALUES (?, ?, ?, ?)
        ''', (account_name, account_type, start_date, starting_balance))
        account_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'account_id': account_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/trade-types', methods=['GET'])
def get_trade_types():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('SELECT * FROM trade_types ORDER BY category, type_name')
        types = cursor.fetchall()
        conn.close()
        
        return jsonify([dict(t) for t in types])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/bankroll-summary', methods=['GET'])
def get_bankroll_summary():
    try:
        # Get date filters, account filter, and status filter
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        account_id = request.args.get('account_id', 9)  # Default to Rule One
        status_filter = request.args.get('status_filter')  # 'open', 'completed', etc.
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get starting bankroll from accounts table
        cursor.execute('''
            SELECT COALESCE(starting_balance, 0) as total
            FROM accounts
            WHERE id = ?
        ''', (account_id,))
        starting_bankroll = cursor.fetchone()['total']
        
        # Build query for premiums based on date filters and account
        query = '''
            SELECT COALESCE(SUM(CASE 
                WHEN trade_type = 'SELL' THEN premium 
                ELSE -premium 
            END), 0) as total_premiums
            FROM trades
            WHERE status != 'roll' AND account_id = ?
        '''
        query_params = [account_id]
        
        if start_date:
            query += ' AND trade_date >= ?'
            query_params.append(start_date)
        if end_date:
            query += ' AND trade_date <= ?'
            query_params.append(end_date)
        
        cursor.execute(query, query_params)
        total_premiums = cursor.fetchone()['total_premiums']
        
        # Total available bankroll = starting + premiums
        total_bankroll = starting_bankroll + total_premiums
        
        # Get total used in open and assigned trades (margin capital) based on date filters
        # Margin Capital = (Strike Price - Net Credit Per Share) * Shares
        # Net Credit Per Share = Premium - Commission
        # So: Margin Capital = (strike_price - (premium - commission)) * (num_of_contracts * 100)
        # Calculate for options trades (not BTO/STC stock trades) that are open or assigned
        # Apply status filter if provided
        base_where = 'status != \'roll\' AND account_id = ? AND trade_type NOT IN (\'BTO\', \'STC\') AND (trade_type LIKE \'%ROCT PUT\' OR trade_type LIKE \'%ROCT CALL\' OR trade_type LIKE \'ROCT%\' OR trade_type LIKE \'BTO CALL\' OR trade_type LIKE \'STC CALL\')'
        
        # Determine status condition
        if status_filter == 'open':
            status_condition = 'status = \'open\''
        elif status_filter == 'completed':
            status_condition = 'status = \'closed\''
        elif status_filter == 'assigned':
            status_condition = 'status = \'assigned\''
        else:
            # Default: include both open and assigned
            status_condition = '(status = \'open\' OR status = \'assigned\')'
        
        query = f'''
            SELECT COALESCE(SUM(
                (strike_price - (premium - COALESCE(commission, 0))) * num_of_contracts * 100
            ), 0) as used
            FROM trades
            WHERE {status_condition} AND {base_where}
        '''
        query_params = [account_id]
        
        if start_date:
            query += ' AND trade_date >= ?'
            query_params.append(start_date)
        if end_date:
            query += ' AND trade_date <= ?'
            query_params.append(end_date)
        
        cursor.execute(query, query_params)
        used_in_trades = cursor.fetchone()['used']
        
        available_bankroll = total_bankroll - used_in_trades
        
        # Also get breakdown by trade type for the donut chart (apply same status filter)
        breakdown_query = f'''
            SELECT 
                trade_type,
                COUNT(*) as count,
                SUM((strike_price - (premium - COALESCE(commission, 0))) * num_of_contracts * 100) as margin_capital
            FROM trades
            WHERE {status_condition} AND {base_where}
        '''
        breakdown_params = [account_id]
        
        if start_date:
            breakdown_query += ' AND trade_date >= ?'
            breakdown_params.append(start_date)
        if end_date:
            breakdown_query += ' AND trade_date <= ?'
            breakdown_params.append(end_date)
        
        breakdown_query += ' GROUP BY trade_type'
        
        cursor.execute(breakdown_query, breakdown_params)
        breakdown = cursor.fetchall()
        
        # Convert breakdown to dictionary
        breakdown_dict = {}
        for row in breakdown:
            breakdown_dict[row['trade_type']] = {
                'count': row['count'],
                'margin_capital': float(row['margin_capital'] or 0)
            }
        
        conn.close()
        
        return jsonify({
            'total_deposits': float(starting_bankroll),
            'total_premiums': float(total_premiums),
            'total_bankroll': float(total_bankroll),
            'used_in_trades': float(used_in_trades),
            'available': float(available_bankroll),
            'breakdown': breakdown_dict
        })
    except Exception as e:
        print(f'Error in bankroll summary: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/cash-flows', methods=['GET'])
def get_cash_flows():
    try:
        account_id = request.args.get('account_id', 9)
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        query = '''
            SELECT cf.*, a.account_name, 
                   COALESCE(tk.ticker, '') as ticker,
                   COALESCE(cf.description, '') as display_description
            FROM cash_flows cf
            LEFT JOIN accounts a ON cf.account_id = a.id
            LEFT JOIN tickers tk ON cf.ticker_id = tk.id
            WHERE cf.account_id = ?
        '''
        params = [account_id]
        
        if start_date:
            query += ' AND cf.transaction_date >= ?'
            params.append(start_date)
        if end_date:
            query += ' AND cf.transaction_date <= ?'
            params.append(end_date)
        
        query += ' ORDER BY cf.transaction_date DESC, cf.created_at DESC'
        
        cursor.execute(query, params)
        cash_flows = cursor.fetchall()
        conn.close()
        
        return jsonify([dict(cf) for cf in cash_flows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/cash-flows', methods=['POST'])
def create_cash_flow():
    try:
        data = request.get_json()
        account_id = data.get('account_id', 9)
        transaction_date = data.get('transaction_date')
        transaction_type = data.get('transaction_type')
        amount = data.get('amount')
        description = data.get('description', '')
        trade_id = data.get('trade_id')
        ticker_id = data.get('ticker_id')
        
        # Round amount to 2 decimal places for NUMERIC(12,2)
        amount = round(float(amount), 2)
        
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO cash_flows 
            (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/trades', methods=['GET'])
def get_trades():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Join with symbols table to get ticker and company name
        cursor.execute('''
            SELECT st.*, s.ticker, s.company_name 
            FROM trades st 
            JOIN tickers s ON st.ticker_id = s.id 
            ORDER BY st.created_at DESC
        ''')
        trades = cursor.fetchall()
        conn.close()
        
        trades_list = []
        for trade in trades:
            trade_dict = dict(trade)
            # Add computed fields for backward compatibility
            trade_dict['shares'] = trade_dict['num_of_contracts'] * 100 if trade_dict['trade_type'] not in ['BTO', 'STC'] else trade_dict['num_of_contracts']
            trades_list.append(trade_dict)
        
        return jsonify(trades_list)
    except Exception as e:
        print(f'Error fetching trades: {e}')
        return jsonify({'error': 'Failed to fetch trades'}), 500

@app.route('/api/trades/<int:trade_id>', methods=['GET'])
def get_trade(trade_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Join with tickers table to get ticker and company name
        cursor.execute('''
            SELECT st.*, t.ticker, t.company_name 
            FROM trades st 
            JOIN tickers t ON st.ticker_id = t.id 
            WHERE st.id = ?
        ''', (trade_id,))
        
        trade = cursor.fetchone()
        conn.close()
        
        if not trade:
            return jsonify({'error': 'Trade not found'}), 404
        
        trade_dict = dict(trade)
        # Add computed fields for backward compatibility
        trade_dict['shares'] = trade_dict['num_of_contracts'] * 100 if trade_dict['trade_type'] not in ['BTO', 'STC'] else trade_dict['num_of_contracts']
        
        return jsonify(trade_dict)
    except Exception as e:
        print(f'Error fetching trade {trade_id}: {e}')
        return jsonify({'error': 'Failed to fetch trade'}), 500

@app.route('/api/trades', methods=['POST'])
def add_trade():
    try:
        data = request.get_json()
        ticker = data['ticker'].upper()
        trade_date = data['tradeDate']
        expiration_date = data['expirationDate']
        num_of_contracts = int(data['num_of_contracts'])
        premium = float(data['premium'])
        current_price = float(data['currentPrice'])
        strike_price = float(data.get('strikePrice', 0))
        trade_type = data.get('tradeType', 'ROCT PUT')
        account_id = data.get('accountId', 9)  # Default to Rule One
        
        # Modify trade type to include ticker for options trades
        if trade_type in ['ROCT PUT', 'ROCT CALL']:
            trade_type = f"{ticker} {trade_type}"
        
        # Get or create symbol
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if symbol exists
        cursor.execute('SELECT id FROM tickers WHERE ticker = ?', (ticker,))
        symbol_row = cursor.fetchone()
        
        if symbol_row:
            ticker_id = symbol_row['id']
        else:
            # Create new symbol
            cursor.execute('INSERT INTO tickers (ticker, company_name) VALUES (?, ?)', (ticker, ticker))
            ticker_id = cursor.lastrowid
        
        # Calculate days to expiration
        trade_date_obj = datetime.strptime(trade_date, '%Y-%m-%d').date()
        expiration = datetime.strptime(expiration_date, '%Y-%m-%d').date()
        days_to_expiration = (expiration - trade_date_obj).days
        
        # Calculate total premium based on trade type
        if trade_type in ['BTO', 'STC']:
            total_premium = premium * num_of_contracts
            price_per_share = premium
            total_amount = total_premium
        else:
            total_premium = premium * num_of_contracts * 100
            price_per_share = 0
            total_amount = 0
        
        # Insert trade
        cursor.execute('''
            INSERT INTO trades 
            (account_id, ticker_id, trade_date, expiration_date, num_of_contracts, premium, total_premium, 
             days_to_expiration, current_price, strike_price, status, trade_type, 
             price_per_share, total_amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, trade_date, expiration_date, num_of_contracts, premium, total_premium,
              days_to_expiration, current_price, strike_price, 'open', trade_type,
              price_per_share, total_amount))
        
        trade_id = cursor.lastrowid
        
        # Create cost basis entry for ALL trades
        if trade_type in ['BTO', 'STC']:
            create_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, trade_type, num_of_contracts, premium, total_premium)
        else:
            # Create cost basis entry for options trades (ROCT PUT, ROCT CALL, etc.)
            create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, trade_type, num_of_contracts, premium, strike_price, expiration_date)
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'trade_id': trade_id})
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'Error adding trade: {e}')
        print(f'Traceback: {error_detail}')
        return jsonify({'error': f'Failed to add trade: {str(e)}'}), 500

def create_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, trade_type, num_of_contracts, price_per_share, total_amount):
    """Create cost basis entry for BTO/STC trades"""
    description = f"{trade_type} {num_of_contracts} {cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,)).fetchone()['ticker']}"
    
    # Get current running totals for this account and ticker
    cursor.execute('''
        SELECT running_basis, running_shares 
        FROM cost_basis 
        WHERE ticker_id = ? AND account_id = ?
        ORDER BY created_at DESC 
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
    if trade_type == 'BTO':
        new_running_basis = running_basis + total_amount
        new_running_shares = running_shares + num_of_contracts
    else:  # STC
        new_running_basis = running_basis - total_amount
        new_running_shares = running_shares - num_of_contracts
    
    # Calculate basis per share
    basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
    
    # Insert cost basis entry
    cursor.execute('''
        INSERT INTO cost_basis 
        (account_id, ticker_id, trade_id, transaction_date, description, shares, cost_per_share, 
         total_amount, running_basis, running_shares, basis_per_share)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (account_id, ticker_id, trade_id, trade_date, description, num_of_contracts, price_per_share,
          total_amount, new_running_basis, new_running_shares, basis_per_share))

def create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, trade_type, num_of_contracts, premium, strike_price, expiration_date):
    """Create cost basis entry for options trades (ROCT PUT, ROCT CALL, etc.)"""
    try:
        # Get ticker for description
        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
        ticker = cursor.fetchone()['ticker']
        
        # Format expiration date as DD-MMM-YY
        try:
            exp_date = datetime.strptime(expiration_date, '%Y-%m-%d')
            expiration_formatted = exp_date.strftime('%d-%b-%y').upper()
        except:
            expiration_formatted = expiration_date  # Fallback
        
        # Create trade description based on trade type
        if 'ROP' in trade_type or 'PUT' in trade_type:
            description = f"SELL -{num_of_contracts} {ticker} 100 {expiration_formatted} {strike_price} PUT @{premium}"
        elif 'ROC' in trade_type or 'CALL' in trade_type:
            description = f"SELL -{num_of_contracts} {ticker} 100 {expiration_formatted} {strike_price} CALL @{premium}"
        else:
            description = f"SELL -{num_of_contracts} {ticker} 100 {expiration_formatted} {strike_price} {trade_type} @{premium}"
        
        # For options trades (contracts):
        # - shares = contracts (1 contract = 100 shares, but we store as contracts)
        # - cost_per_share = premium (the premium per contract)
        # - total_amount = premium * num_of_contracts (total premium collected, negative for SELL)
        shares = num_of_contracts  # Contracts
        cost_per_share = premium
        total_amount = -(premium * num_of_contracts)
        
        # Get current running totals for this account and ticker
        cursor.execute('''
            SELECT running_basis, running_shares 
            FROM cost_basis 
            WHERE ticker_id = ? AND account_id = ?
            ORDER BY created_at DESC 
            LIMIT 1
        ''', (ticker_id, account_id))
        
        last_entry = cursor.fetchone()
        if last_entry:
            running_basis = last_entry['running_basis']
            running_shares = last_entry['running_shares']
        else:
            running_basis = 0
            running_shares = 0
        
        # Update running totals (for options, shares represents contracts)
        new_running_basis = running_basis + total_amount
        new_running_shares = running_shares + shares  # Add contracts
        
        # Calculate basis per share
        basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else total_amount
        
        # Insert cost basis entry
        cursor.execute('''
            INSERT INTO cost_basis 
            (account_id, ticker_id, trade_id, transaction_date, description, shares, cost_per_share, 
             total_amount, running_basis, running_shares, basis_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, trade_id, trade_date, description, shares, cost_per_share,
              total_amount, new_running_basis, new_running_shares, basis_per_share))
        
        print(f"Created cost basis entry for options trade {trade_id}: {description}")
        
    except Exception as e:
        print(f"Error creating options cost basis entry: {e}")

@app.route('/api/trades/<int:trade_id>', methods=['DELETE'])
def delete_trade(trade_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get trade info before deletion
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade = cursor.fetchone()
        
        if not trade:
            return jsonify({'error': 'Trade not found'}), 404
        
        # Delete associated cost basis entries
        cursor.execute('DELETE FROM cost_basis WHERE trade_id = ?', (trade_id,))
        
        # Delete the trade
        cursor.execute('DELETE FROM trades WHERE id = ?', (trade_id,))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        print(f'Error deleting trade: {e}')
        return jsonify({'error': 'Failed to delete trade'}), 500

@app.route('/api/trades/<int:trade_id>', methods=['PUT'])
def update_trade(trade_id):
    try:
        data = request.get_json()
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get current trade
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade = cursor.fetchone()
        
        if not trade:
            return jsonify({'error': 'Trade not found'}), 404
        
        # Update trade fields
        updates = []
        params = []
        
        if 'ticker' in data:
            ticker = data['ticker'].upper()
            # Get or create symbol
            cursor.execute('SELECT id FROM tickers WHERE ticker = ?', (ticker,))
            symbol_row = cursor.fetchone()
            
            if symbol_row:
                ticker_id = symbol_row['id']
            else:
                cursor.execute('INSERT INTO tickers (ticker, company_name) VALUES (?, ?)', (ticker, ticker))
                ticker_id = cursor.lastrowid
            
            updates.append('ticker_id = ?')
            params.append(ticker_id)
        
        if 'tradeDate' in data:
            updates.append('trade_date = ?')
            params.append(data['tradeDate'])
        
        if 'expirationDate' in data:
            updates.append('expiration_date = ?')
            params.append(data['expirationDate'])
        
        if 'num_of_contracts' in data:
            updates.append('num_of_contracts = ?')
            params.append(int(data['num_of_contracts']))
        
        if 'premium' in data:
            updates.append('premium = ?')
            params.append(float(data['premium']))
        
        if 'currentPrice' in data:
            updates.append('current_price = ?')
            params.append(float(data['currentPrice']))
        
        if 'strikePrice' in data:
            updates.append('strike_price = ?')
            params.append(float(data['strikePrice']))
        
        if 'tradeType' in data:
            updates.append('trade_type = ?')
            params.append(data['tradeType'])
        
        if updates:
            params.append(trade_id)
            query = f"UPDATE trades SET {', '.join(updates)} WHERE id = ?"
            cursor.execute(query, params)
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        print(f'Error updating trade: {e}')
        return jsonify({'error': 'Failed to update trade'}), 500

@app.route('/api/trades/<int:trade_id>/status', methods=['PUT'])
def update_trade_status(trade_id):
    try:
        data = request.get_json()
        new_status = data['status']
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get current trade
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade = cursor.fetchone()
        
        if not trade:
            return jsonify({'error': 'Trade not found'}), 404
        
        old_status = trade['status']
        
        # Update status
        cursor.execute('UPDATE trades SET status = ? WHERE id = ?', (new_status, trade_id))
        
        # Record status change
        cursor.execute('''
            INSERT INTO trade_status_history (trade_id, old_status, new_status)
            VALUES (?, ?, ?)
        ''', (trade_id, old_status, new_status))
        
        # Handle assigned trades - create cost basis entry
        if new_status == 'assigned' and old_status != 'assigned':
            create_assigned_cost_basis_entry(cursor, trade)
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        print(f'Error updating trade status: {e}')
        return jsonify({'error': 'Failed to update trade status'}), 500

def create_assigned_cost_basis_entry(cursor, trade):
    """Create cost basis entry for assigned trades"""
    print(f"Creating assigned cost basis entry for trade: {trade}")
    account_id = trade.get('account_id', 9)  # Default to Rule One
    ticker_id = trade['ticker_id']
    trade_id = trade['id']
    trade_date = trade['trade_date']
    trade_type = trade['trade_type']
    num_of_contracts = trade['num_of_contracts']
    strike_price = trade['strike_price']
    
    # Get ticker for description
    cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
    ticker = cursor.fetchone()['ticker']
    
    # Format expiration date
    exp_date = datetime.strptime(trade['expiration_date'], '%Y-%m-%d').strftime('%d-%b-%y').upper()
    
    # Calculate shares: num_of_contracts is in contracts, so multiply by 100
    num_shares = num_of_contracts * 100
    
    if 'PUT' in trade_type.upper():
        description = f"ASSIGNED - Bought {num_shares} shares @ ${strike_price} (PUT Option)"
        shares = num_shares  # Positive for bought shares
        cost_per_share = strike_price
        total_amount = strike_price * shares
    else:  # CALL
        description = f"ASSIGNED - Sold {num_shares} shares @ ${strike_price} (CALL Option)"
        shares = -num_shares  # Negative for sold shares
        cost_per_share = strike_price
        total_amount = -(strike_price * num_shares)  # Make negative for sold
    
    # Get current running totals for this account and ticker
    cursor.execute('''
        SELECT running_basis, running_shares 
        FROM cost_basis 
        WHERE ticker_id = ? AND account_id = ?
        ORDER BY created_at DESC 
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
    new_running_shares = running_shares + shares
    
    # Calculate basis per share
    basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
    
    # Insert cost basis entry
    cursor.execute('''
        INSERT INTO cost_basis 
        (account_id, ticker_id, trade_id, transaction_date, description, shares, cost_per_share, 
         total_amount, running_basis, running_shares, basis_per_share)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (account_id, ticker_id, trade_id, trade_date, description, shares, cost_per_share,
          total_amount, new_running_basis, new_running_shares, basis_per_share))

@app.route('/api/trades/<int:trade_id>/field', methods=['PUT'])
def update_trade_field(trade_id):
    try:
        data = request.get_json()
        field = data['field']
        value = data['value']
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Validate field name
        valid_fields = ['num_of_contracts', 'premium', 'strike_price', 'status']
        if field not in valid_fields:
            return jsonify({'error': 'Invalid field'}), 400
        
        # Update the field
        cursor.execute(f'UPDATE trades SET {field} = ? WHERE id = ?', (value, trade_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        print(f'Error updating trade field: {e}')
        return jsonify({'error': 'Failed to update trade field'}), 500

@app.route('/api/company-search')
def company_search():
    try:
        query = request.args.get('q', '').upper()
        
        if not query:
            return jsonify([])
        
        # Use Alpha Vantage API to search for companies
        api_key = os.environ.get('ALPHA_VANTAGE_API_KEY')
        if not api_key:
            return jsonify({'error': 'Alpha Vantage API key not configured'}), 500
        
        # Alpha Vantage Symbol Search API
        url = f'https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords={query}&apikey={api_key}'
        
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        
        if 'Error Message' in data:
            return jsonify({'error': data['Error Message']}), 500
        
        if 'Note' in data:
            return jsonify({'error': 'API rate limit exceeded'}), 429
        
        companies = []
        if 'bestMatches' in data:
            for match in data['bestMatches'][:10]:  # Limit to 10 results
                companies.append({
                    'symbol': match['1. symbol'],
                    'name': match['2. name']
                })
        
        return jsonify(companies)
    except requests.exceptions.RequestException as e:
        print(f'Error fetching from Alpha Vantage: {e}')
        return jsonify({'error': 'Failed to fetch company data'}), 500
    except Exception as e:
        print(f'Error searching companies: {e}')
        return jsonify([])

@app.route('/api/company-info/<ticker>')
def get_company_info(ticker):
    try:
        api_key = os.environ.get('ALPHA_VANTAGE_API_KEY')
        if not api_key:
            return jsonify({'error': 'Alpha Vantage API key not configured'}), 500
        
        # Use Alpha Vantage Symbol Search API to get company info
        url = f'https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords={ticker}&apikey={api_key}'
        
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        
        if 'Error Message' in data:
            return jsonify({'error': data['Error Message']}), 500
        
        if 'Note' in data:
            return jsonify({'error': 'API rate limit exceeded'}), 429
        
        # Find exact match for the ticker
        if 'bestMatches' in data:
            for match in data['bestMatches']:
                if match['1. symbol'].upper() == ticker.upper():
                    return jsonify({
                        'symbol': match['1. symbol'],
                        'name': match['2. name']
                    })
        
        # If no exact match found, return ticker as name
        return jsonify({
            'symbol': ticker,
            'name': ticker
        })
    except requests.exceptions.RequestException as e:
        print(f'Error fetching company info from Alpha Vantage: {e}')
        return jsonify({'symbol': ticker, 'name': ticker})
    except Exception as e:
        print(f'Error getting company info: {e}')
        return jsonify({'symbol': ticker, 'name': ticker})

@app.route('/api/top-symbols')
def get_top_symbols():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get top 10 most commonly used ticker symbols with status information
        cursor.execute('''
            SELECT t.ticker, COUNT(st.id) as trade_count,
                   MAX(CASE WHEN st.status = 'open' THEN 1 ELSE 0 END) as has_open_trades,
                   MAX(CASE WHEN st.status IN ('assigned', 'expired') THEN st.trade_date ELSE NULL END) as last_assigned_expired_date
            FROM tickers t
            JOIN trades st ON t.id = st.ticker_id
            WHERE t.ticker IS NOT NULL AND t.ticker != ""
            GROUP BY t.ticker
            ORDER BY trade_count DESC
            LIMIT 10
        ''')
        
        results = cursor.fetchall()
        conn.close()
        
        top_symbols = []
        for result in results:
            # Calculate if last assigned/expired trade was more than 30 days ago
            last_assigned_expired = result['last_assigned_expired_date']
            is_old_assigned_expired = False
            
            if last_assigned_expired:
                try:
                    from datetime import datetime, timedelta
                    last_date = datetime.strptime(str(last_assigned_expired), '%Y-%m-%d')
                    thirty_days_ago = datetime.now() - timedelta(days=30)
                    is_old_assigned_expired = last_date < thirty_days_ago
                except:
                    is_old_assigned_expired = False
            
            top_symbols.append({
                'ticker': result['ticker'],
                'trade_count': result['trade_count'],
                'has_open_trades': bool(result['has_open_trades']),
                'is_old_assigned_expired': is_old_assigned_expired
            })
        
        return jsonify(top_symbols)
    except Exception as e:
        print(f'Error fetching top symbols: {e}')
        return jsonify([])

@app.route('/api/cost-basis')
def get_cost_basis():
    try:
        # Get commission from query parameter (default to 0)
        commission = float(request.args.get('commission', 0.0))
        
        # Get ticker from query parameter (optional)
        ticker = request.args.get('ticker')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        if ticker:
            cursor.execute('SELECT st.*, s.ticker FROM trades st JOIN tickers s ON st.ticker_id = s.id WHERE s.ticker = ? AND s.ticker IS NOT NULL AND s.ticker != "" ORDER BY s.ticker, st.trade_date ASC', (ticker,))
        else:
            cursor.execute('SELECT st.*, s.ticker FROM trades st JOIN tickers s ON st.ticker_id = s.id WHERE s.ticker IS NOT NULL AND s.ticker != "" ORDER BY s.ticker, st.trade_date ASC')
        
        trades = cursor.fetchall()
        conn.close()
        
        # Group trades by ticker
        ticker_groups = {}
        for trade in trades:
            ticker = trade['ticker']
            if ticker not in ticker_groups:
                ticker_groups[ticker] = {
                    'trades': []
                }
            ticker_groups[ticker]['trades'].append(dict(trade))
        
        result = []
        for ticker, ticker_data in ticker_groups.items():
            trades_list = ticker_data['trades']
            
            # Fetch company name from Alpha Vantage API
            try:
                api_key = os.environ.get('ALPHA_VANTAGE_API_KEY')
                if api_key:
                    url = f'https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords={ticker}&apikey={api_key}'
                    response = requests.get(url, timeout=5)
                    if response.status_code == 200:
                        data = response.json()
                        if 'bestMatches' in data:
                            for match in data['bestMatches']:
                                if match['1. symbol'].upper() == ticker.upper():
                                    company_name = match['2. name']
                                    break
                            else:
                                company_name = ticker
                        else:
                            company_name = ticker
                    else:
                        company_name = ticker
                else:
                    company_name = ticker
            except:
                company_name = ticker
            
            # Sort trades by trade date (ascending - oldest first)
            trades_list.sort(key=lambda x: x['trade_date'])
            
            # Calculate running totals for basis column
            running_basis = 0
            running_shares = 0
            
            for trade in trades_list:
                # Generate trade description if not already present
                if not trade.get('trade_description'):
                    if trade['trade_type'] == 'BTO':
                        trade['trade_description'] = f"BTO {trade['num_of_contracts']} {trade['ticker']}"
                    elif trade['trade_type'] == 'STC':
                        trade['trade_description'] = f"STC {trade['num_of_contracts']} {trade['ticker']}"
                    elif trade['trade_type'] == 'ASSIGNED':
                        # Format expiration date to DD-MMM-YY
                        try:
                            exp_date = datetime.strptime(str(trade['expiration_date']), '%Y-%m-%d')
                            formatted_date = exp_date.strftime('%d-%b-%y').upper()
                        except:
                            formatted_date = str(trade['expiration_date'])
                        
                        if 'PUT' in trade.get('trade_description', '') or 'put' in trade.get('trade_description', '').lower():
                            trade['trade_description'] = f"Assigned {formatted_date} PUT"
                        elif 'CALL' in trade.get('trade_description', '') or 'call' in trade.get('trade_description', '').lower():
                            trade['trade_description'] = f"Assigned {formatted_date} CALL"
                        else:
                            trade['trade_description'] = f"Assigned {formatted_date}"
                    elif trade['trade_type'] not in ['BTO', 'STC', 'ASSIGNED']:
                        # Format expiration date to DD-MMM-YY
                        try:
                            exp_date = datetime.strptime(str(trade['expiration_date']), '%Y-%m-%d')
                            formatted_date = exp_date.strftime('%d-%b-%y').upper()
                        except:
                            formatted_date = str(trade['expiration_date'])
                        
                        if 'ROP' in trade['trade_type'] or 'PUT' in trade['trade_type']:
                            trade['trade_description'] = f"SELL -{trade['num_of_contracts']} {trade['ticker']} 100 {formatted_date} {trade['strike_price']} PUT @{trade['premium']}"
                        elif 'ROC' in trade['trade_type'] or 'CALL' in trade['trade_type']:
                            trade['trade_description'] = f"SELL -{trade['num_of_contracts']} {trade['ticker']} 100 {formatted_date} {trade['strike_price']} CALL @{trade['premium']}"
                        else:
                            trade['trade_description'] = f"SELL -{trade['num_of_contracts']} {trade['ticker']} 100 {formatted_date} {trade['strike_price']} {trade['trade_type']} @{trade['premium']}"
                
                # Calculate shares based on trade type
                if trade['trade_type'] == 'BTO':
                    shares = trade['num_of_contracts']
                elif trade['trade_type'] == 'STC':
                    shares = -trade['num_of_contracts']
                else:
                    shares = trade['num_of_contracts'] * 100
                
                trade['shares'] = shares
                
                # Calculate basis based on trade type
                if trade['trade_type'] in ['BTO', 'STC']:
                    # For stock trades, basis = amount (positive for BTO, negative for STC)
                    trade['basis'] = trade.get('total_amount', 0)
                    trade['amount'] = trade.get('total_amount', 0)
                else:
                    # For options trades, basis = -(premium * num_of_contracts * 100) - commission
                    trade['basis'] = -(trade['premium'] * trade['num_of_contracts'] * 100) - (commission * shares)
                    trade['amount'] = -(trade['premium'] * trade['num_of_contracts'] * 100) - (commission * shares)
                
                # Update running totals
                running_shares += trade['shares']
                running_basis += trade['basis']
                
                # Update the trade with running totals
                trade['running_basis'] = running_basis
                trade['running_shares'] = running_shares
                
                # Calculate running basis per share
                # If total shares are 0, use the same value as basis
                try:
                    if running_shares == 0:
                        trade['running_basis_per_share'] = running_basis
                    else:
                        trade['running_basis_per_share'] = running_basis / running_shares
                except (ZeroDivisionError, TypeError):
                    trade['running_basis_per_share'] = running_basis
            
            # Calculate totals
            total_shares = sum(trade['shares'] for trade in trades_list)
            total_cost_basis = sum(trade['basis'] for trade in trades_list)
            
            try:
                if total_shares != 0:
                    total_cost_basis_per_share = total_cost_basis / total_shares
                else:
                    total_cost_basis_per_share = 0
            except (ZeroDivisionError, TypeError):
                total_cost_basis_per_share = 0
            
            result.append({
                'ticker': ticker,
                'company_name': company_name,
                'total_shares': total_shares,
                'total_cost_basis': total_cost_basis,
                'total_cost_basis_per_share': total_cost_basis_per_share,
                'trades': trades_list
            })
        
        return jsonify(result)
    except Exception as e:
        print(f'Error fetching cost basis: {e}')
        return jsonify({'error': 'Failed to fetch cost basis'}), 500

@app.route('/api/summary')
def get_summary():
    try:
        start_date = request.args.get('start_date', '')
        end_date = request.args.get('end_date', '')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Build query with date filters
        query = '''
            SELECT st.*, s.ticker 
            FROM trades st 
            JOIN tickers s ON st.ticker_id = s.id 
            WHERE s.ticker IS NOT NULL AND s.ticker != "" 
            AND st.trade_type NOT IN ("BTO", "STC", "ASSIGNED")
            AND st.status != "roll"
        '''
        params = []
        
        if start_date:
            query += ' AND st.trade_date >= ?'
            params.append(start_date)
        
        if end_date:
            query += ' AND st.trade_date <= ?'
            params.append(end_date)
        
        cursor.execute(query, params)
        trades = cursor.fetchall()
        conn.close()
        
        # Calculate summary statistics
        total_trades = len(trades)
        open_trades = len([t for t in trades if t['status'] == 'open'])
        closed_trades = len([t for t in trades if t['status'] in ['closed', 'expired', 'assigned']])
        
        # Calculate wins and losses only from completed trades
        completed_trades_list = [t for t in trades if t['status'] in ['closed', 'expired', 'assigned']]
        wins = len([t for t in completed_trades_list if t['total_premium'] > 0])
        losses = len([t for t in completed_trades_list if t['total_premium'] < 0])
        winning_percentage = (wins / len(completed_trades_list) * 100) if len(completed_trades_list) > 0 else 0
        
        total_net_credit = sum(t['total_premium'] for t in trades)
        
        # Calculate days remaining in year
        today = datetime.now().date()
        year_end = datetime(today.year, 12, 31).date()
        days_remaining = (year_end - today).days
        
        # Calculate days done in year
        year_start = datetime(today.year, 1, 1).date()
        days_done = (today - year_start).days
        
        return jsonify({
            'total_trades': total_trades,
            'open_trades': open_trades,
            'closed_trades': closed_trades,
            'wins': wins,
            'losses': losses,
            'winning_percentage': round(winning_percentage, 1),
            'total_net_credit': total_net_credit,
            'days_remaining': days_remaining,
            'days_done': days_done
        })
    except Exception as e:
        print(f'Error fetching summary: {e}')
        return jsonify({'error': 'Failed to fetch summary'}), 500

@app.route('/api/chart-data')
def get_chart_data():
    try:
        start_date = request.args.get('start_date', '')
        end_date = request.args.get('end_date', '')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Build query with date filters
        query = '''
            SELECT st.trade_date, SUM(st.total_premium) as daily_premium
            FROM trades st 
            JOIN tickers s ON st.ticker_id = s.id 
            WHERE s.ticker IS NOT NULL AND s.ticker != "" 
            AND st.trade_type NOT IN ("BTO", "STC", "ASSIGNED")
        '''
        params = []
        
        if start_date:
            query += ' AND st.trade_date >= ?'
            params.append(start_date)
        
        if end_date:
            query += ' AND st.trade_date <= ?'
            params.append(end_date)
        
        query += ' GROUP BY st.trade_date ORDER BY st.trade_date'
        
        cursor.execute(query, params)
        data = cursor.fetchall()
        conn.close()
        
        chart_data = []
        for row in data:
            # Format date as MM/DD
            date_obj = datetime.strptime(row['trade_date'], '%Y-%m-%d')
            formatted_date = date_obj.strftime('%m/%d')
            
            chart_data.append({
                'date': formatted_date,
                'premium': row['daily_premium']
            })
        
        return jsonify(chart_data)
    except Exception as e:
        print(f'Error fetching chart data: {e}')
        return jsonify({'error': 'Failed to fetch chart data'}), 500

@app.route('/test')
def test_endpoint():
    """Simple test endpoint to verify app is running"""
    return 'App is running!', 200

@app.route('/webhook/deploy', methods=['POST'])
def webhook_deploy():
    """Webhook endpoint for automatic deployment from GitHub"""
    try:
        import subprocess
        import os
        import hmac
        import hashlib
        
        # Optional: Verify webhook secret for security
        # webhook_secret = os.environ.get('WEBHOOK_SECRET', '')
        # if webhook_secret:
        #     signature = request.headers.get('X-Hub-Signature-256', '')
        #     if not signature.startswith('sha256='):
        #         return 'Invalid signature', 401
        #     
        #     expected_signature = 'sha256=' + hmac.new(
        #         webhook_secret.encode(),
        #         request.get_data(),
        #         hashlib.sha256
        #     ).hexdigest()
        #     
        #     if not hmac.compare_digest(signature, expected_signature):
        #         return 'Signature mismatch', 401
        
        # Change to the project directory
        project_dir = '/home/greenmangroup/stock-options-tracker'
        
        # Pull latest changes from GitHub
        result = subprocess.run(['git', 'pull'], 
                              cwd=project_dir, 
                              capture_output=True, 
                              text=True)
        
        if result.returncode == 0:
            print(f"Deployment successful: {result.stdout}")
            
            # Trigger reload by touching the WSGI file or restarting the task
            # For PythonAnywhere, touching the WSGI file triggers a reload
            wsgi_file = '/var/www/stockoptionstracker_pythonanywhere_com_wsgi.py'
            if os.path.exists(wsgi_file):
                os.utime(wsgi_file, None)
                print("Reloaded WSGI application")
            
            return 'Deployment successful', 200
        else:
            print(f"Deployment failed: {result.stderr}")
            return f'Deployment failed: {result.stderr}', 500
            
    except Exception as e:
        print(f"Webhook deployment error: {e}")
        return f'Deployment error: {str(e)}', 500

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5005)
