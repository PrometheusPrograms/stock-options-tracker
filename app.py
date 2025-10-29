from flask import Flask, render_template, request, jsonify
import sqlite3
import os
import re
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv
import pandas as pd
import io
import zipfile
import logging

# Load environment variables
load_dotenv()

app = Flask(__name__)

# Setup logging to file
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('flask_debug.log'),
        logging.StreamHandler()
    ]
)

# Database configuration
DATABASE = 'trades.db'

def get_db_connection():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def create_views(cursor):
    """Create SQL views to simplify reporting queries"""
    views = [
        '''
        CREATE VIEW IF NOT EXISTS v_trade_summary AS
        SELECT 
            t.id,
            t.account_id,
            tk.ticker,
            tk.company_name,
            t.trade_date,
            t.expiration_date,
            t.num_of_contracts,
            t.credit_debit,
            t.total_premium,
            t.days_to_expiration,
            t.current_price,
            t.strike_price,
            t.trade_status,
            t.trade_type,
            t.commission_paid,
            t.created_at,
            t.strike_price - t.credit_debit AS net_credit_per_share
        FROM trades t
        JOIN tickers tk ON t.ticker_id = tk.id
        ''',
        '''
        CREATE VIEW IF NOT EXISTS v_cost_basis_summary AS
        SELECT 
            cb.ticker_id,
            cb.account_id,
            tk.ticker,
            cb.transaction_date,
            cb.description,
            cb.running_basis,
            cb.running_shares,
            cb.basis_per_share,
            t.trade_status as status
        FROM cost_basis cb
        JOIN tickers tk ON cb.ticker_id = tk.id
        LEFT JOIN trades t ON cb.trade_id = t.id
        ''',
        '''
        CREATE VIEW IF NOT EXISTS v_cash_flow_summary AS
        SELECT 
            cf.account_id,
            cf.transaction_type,
            COUNT(*) AS transaction_count,
            SUM(cf.amount) AS total_amount
        FROM cash_flows cf
        GROUP BY cf.account_id, cf.transaction_type
        '''
    ]
    
    for view_sql in views:
        try:
            cursor.execute(view_sql)
        except sqlite3.OperationalError as e:
            # View might already exist, skip
            pass

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
            company_name TEXT,
            sector TEXT,
            market_cap REAL,
            needs_update BOOLEAN DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Add needs_update column if it doesn't exist
    try:
        cursor.execute('ALTER TABLE tickers ADD COLUMN needs_update BOOLEAN DEFAULT 0')
    except sqlite3.OperationalError:
        pass  # Column already exists
    
    # Create trades table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER DEFAULT 9,
            ticker_id INTEGER NOT NULL,
            trade_date TEXT NOT NULL,
            expiration_date TEXT NOT NULL,
            num_of_contracts INTEGER NOT NULL,
            credit_debit REAL NOT NULL,
            total_premium REAL NOT NULL,
            days_to_expiration INTEGER NOT NULL,
            current_price REAL NOT NULL,
            strike_price REAL NOT NULL,
            trade_status TEXT DEFAULT 'open',
            trade_type TEXT NOT NULL,
            commission_paid REAL DEFAULT 0,
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
            cash_flow_id INTEGER,
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
            FOREIGN KEY (trade_id) REFERENCES trades(id),
            FOREIGN KEY (cash_flow_id) REFERENCES cash_flows(id)
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
            account_id INTEGER NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_amount REAL NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id)
        )
    ''')
    
    # Add account_id to bankroll if it doesn't exist (for existing databases)
    cursor.execute("PRAGMA table_info(bankroll)")
    columns = [col[1] for col in cursor.fetchall()]
    if 'account_id' not in columns:
        cursor.execute('ALTER TABLE bankroll ADD COLUMN account_id INTEGER')
        cursor.execute('UPDATE bankroll SET account_id = 9 WHERE account_id IS NULL')
    
    # Create cash_flows table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cash_flows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'OPTIONS', 'ASSIGNMENT', 'BUY', 'SELL')),
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
    
    # Check if the table exists and recreate it if it has the old CHECK constraint
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cash_flows'")
    if cursor.fetchone():
        try:
            # Try to insert a test OPTIONS record to check if the constraint allows it
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount)
                VALUES (?, '2000-01-02', 'OPTIONS', 0.01)
            ''', (1,))
            cursor.execute('DELETE FROM cash_flows WHERE transaction_type = "OPTIONS" AND transaction_date = "2000-01-02"')
        except:
            # If OPTIONS is not allowed, the table has the old constraint, so recreate it
            print("Recreating cash_flows table with updated CHECK constraint...")
            # Save existing data
            cursor.execute('SELECT * FROM cash_flows')
            existing_data = [dict(row) for row in cursor.fetchall()]
            
            # Drop and recreate the table
            cursor.execute('DROP TABLE cash_flows')
            cursor.execute('''
                CREATE TABLE cash_flows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    transaction_date TEXT NOT NULL,
                    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'OPTIONS', 'ASSIGNMENT', 'BUY', 'SELL')),
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
            
            # Restore existing data
            for row_dict in existing_data:
                cursor.execute('''
                    INSERT INTO cash_flows (id, account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (row_dict['id'], row_dict['account_id'], row_dict['transaction_date'], row_dict['transaction_type'], 
                      row_dict['amount'], row_dict.get('description'), row_dict.get('trade_id'), row_dict.get('ticker_id'), row_dict.get('created_at')))
            
            # Commit the changes
            conn.commit()
    
    # Migration: Rename status to trade_status if table exists with old schema
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades'")
    if cursor.fetchone():
        # Check if the column is named 'status' instead of 'trade_status'
        cursor.execute("PRAGMA table_info(trades)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if ('status' in columns and 'trade_status' not in columns) or \
           ('premium' in columns and 'credit_debit' not in columns) or \
           ('commission' in columns and 'commission_paid' not in columns):
            print("Renaming 'status' column to 'trade_status' in trades table...")
            # SQLite doesn't support RENAME COLUMN in older versions, so we need to:
            # 1. Drop views that depend on trades table
            # 2. Create new table with new schema
            # 3. Copy data
            # 4. Drop old table
            # 5. Rename new table
            # 6. Recreate views
            
            try:
                cursor.execute('DROP VIEW IF EXISTS v_trade_summary')
                cursor.execute('DROP VIEW IF EXISTS v_cost_basis_summary')
                cursor.execute('DROP VIEW IF EXISTS v_cash_flow_summary')
            except:
                pass
            
            cursor.execute('''
                CREATE TABLE trades_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER DEFAULT 9,
                    ticker_id INTEGER NOT NULL,
                    trade_date TEXT NOT NULL,
                    expiration_date TEXT NOT NULL,
                    num_of_contracts INTEGER NOT NULL,
                    credit_debit REAL NOT NULL,
                    total_premium REAL NOT NULL,
                    days_to_expiration INTEGER NOT NULL,
                    current_price REAL NOT NULL,
                    strike_price REAL NOT NULL,
                    trade_status TEXT DEFAULT 'open',
                    trade_type TEXT NOT NULL,
                    commission_paid REAL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    price_per_share REAL DEFAULT 0,
                    total_amount REAL DEFAULT 0,
                    margin_capital REAL DEFAULT 0,
                    FOREIGN KEY (ticker_id) REFERENCES tickers(id),
                    FOREIGN KEY (account_id) REFERENCES accounts(id)
                )
            ''')
            
            # Copy data from old table to new table
            cursor.execute('''
                INSERT INTO trades_new (id, account_id, ticker_id, trade_date, expiration_date, num_of_contracts, 
                                      credit_debit, total_premium, days_to_expiration, current_price, strike_price, 
                                      trade_status, trade_type, commission_paid, created_at, price_per_share, total_amount, margin_capital)
                SELECT id, account_id, ticker_id, trade_date, expiration_date, num_of_contracts,
                       COALESCE(premium, 0) as credit_debit, total_premium, days_to_expiration, current_price, strike_price,
                       COALESCE(status, 'open') as trade_status, trade_type, COALESCE(commission, 0) as commission_paid, created_at, price_per_share, total_amount, margin_capital
                FROM trades
            ''')
            
            # Drop old table and rename new one
            cursor.execute('DROP TABLE trades')
            cursor.execute('ALTER TABLE trades_new RENAME TO trades')
            
            # Recreate views
            create_views(cursor)
            
            conn.commit()
            print("Successfully renamed 'status' to 'trade_status'")

    # Create commissions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS commissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            commission_rate REAL NOT NULL,
            effective_date TEXT NOT NULL,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id)
        )
    ''')
    
    # Create trade_types table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trade_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type_name TEXT UNIQUE NOT NULL,
            description TEXT,
            category TEXT NOT NULL,
            is_credit BOOLEAN DEFAULT 0,
            requires_expiration BOOLEAN DEFAULT 1,
            requires_strike BOOLEAN DEFAULT 1,
            requires_contracts BOOLEAN DEFAULT 1,
            requires_shares BOOLEAN DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Migrate trade_types table if it has type_code column (old schema)
    try:
        cursor.execute("PRAGMA table_info(trade_types)")
        # Column info returns tuples: (cid, name, type, notnull, default_value, pk)
        columns = [col[1] for col in cursor.fetchall()]
        if 'type_code' in columns:
            print("Migrating trade_types table: removing type_code column", flush=True)
            # Copy data to new table without type_code
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS trade_types_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type_name TEXT UNIQUE NOT NULL,
                    description TEXT,
                    category TEXT NOT NULL,
                    is_credit BOOLEAN DEFAULT 0,
                    requires_expiration BOOLEAN DEFAULT 1,
                    requires_strike BOOLEAN DEFAULT 1,
                    requires_contracts BOOLEAN DEFAULT 1,
                    requires_shares BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            cursor.execute('''
                INSERT INTO trade_types_new (id, type_name, description, category, is_credit, requires_expiration, requires_strike, requires_contracts, requires_shares, created_at)
                SELECT id, type_name, description, category, is_credit, requires_expiration, requires_strike, requires_contracts, requires_shares, created_at
                FROM trade_types
            ''')
            cursor.execute('DROP TABLE trade_types')
            cursor.execute('ALTER TABLE trade_types_new RENAME TO trade_types')
    except Exception as e:
        print(f"Migration note: {e}", flush=True)
    
    # Add trade_type_id column to trades table if it doesn't exist
    try:
        cursor.execute('ALTER TABLE trades ADD COLUMN trade_type_id INTEGER')
    except sqlite3.OperationalError:
        pass  # Column already exists
    
    # Add cash_flow_id column to cost_basis table if it doesn't exist
    try:
        cursor.execute('ALTER TABLE cost_basis ADD COLUMN cash_flow_id INTEGER')
    except sqlite3.OperationalError:
        pass  # Column already exists
    
    # Insert default trade types
    cursor.execute('''
        INSERT OR IGNORE INTO trade_types (type_name, description, category, is_credit, requires_expiration, requires_strike, requires_contracts, requires_shares) 
        VALUES 
        ('ROCT PUT', 'Roll Over Cash-secured PUT', 'OPTIONS', 1, 1, 1, 1, 0),
        ('ROCT CALL', 'Roll Over Cash-secured CALL', 'OPTIONS', 1, 1, 1, 1, 0),
        ('BTO', 'Buy To Open Stock', 'STOCK', 0, 0, 0, 0, 1),
        ('STC', 'Sell To Close Stock', 'STOCK', 0, 0, 0, 0, 1)
    ''')
    
    # Create SQL views to simplify queries
    create_views(cursor)
    
    # Create indexes for query optimization
    create_indexes(cursor)
    
    conn.commit()
    conn.close()

def create_indexes(cursor):
    """Create indexes for query optimization"""
    indexes = [
        # TRADES TABLE
        'CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account_id)',
        'CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(trade_status)',
        'CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker_id)',
        'CREATE INDEX IF NOT EXISTS idx_trades_trade_date ON trades(trade_date)',
        'CREATE INDEX IF NOT EXISTS idx_trades_account_status ON trades(account_id, trade_status)',
        'CREATE INDEX IF NOT EXISTS idx_trades_account_date ON trades(account_id, trade_date)',
        'CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(trade_type)',
        'CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC)',
        
        # COST_BASIS TABLE
        'CREATE INDEX IF NOT EXISTS idx_cost_basis_ticker_account ON cost_basis(ticker_id, account_id)',
        'CREATE INDEX IF NOT EXISTS idx_cost_basis_transaction_date ON cost_basis(transaction_date)',
        'CREATE INDEX IF NOT EXISTS idx_cost_basis_account ON cost_basis(account_id)',
        'CREATE INDEX IF NOT EXISTS idx_cost_basis_ticker ON cost_basis(ticker_id)',
        'CREATE INDEX IF NOT EXISTS idx_cost_basis_ticker_account_date ON cost_basis(ticker_id, account_id, transaction_date)',
        
        # CASH_FLOWS TABLE
        'CREATE INDEX IF NOT EXISTS idx_cash_flows_account ON cash_flows(account_id)',
        'CREATE INDEX IF NOT EXISTS idx_cash_flows_type ON cash_flows(transaction_type)',
        'CREATE INDEX IF NOT EXISTS idx_cash_flows_date ON cash_flows(transaction_date)',
        'CREATE INDEX IF NOT EXISTS idx_cash_flows_account_date ON cash_flows(account_id, transaction_date)',
        'CREATE INDEX IF NOT EXISTS idx_cash_flows_account_type ON cash_flows(account_id, transaction_type)',
        'CREATE INDEX IF NOT EXISTS idx_cash_flows_ticker ON cash_flows(ticker_id)',
        
        # COMMISSIONS TABLE
        'CREATE INDEX IF NOT EXISTS idx_commissions_account_date ON commissions(account_id, effective_date)',
        'CREATE INDEX IF NOT EXISTS idx_commissions_account ON commissions(account_id)',
        
        # BANKROLL TABLE
        'CREATE INDEX IF NOT EXISTS idx_bankroll_account ON bankroll(account_id)',
        'CREATE INDEX IF NOT EXISTS idx_bankroll_date ON bankroll(transaction_date)',
        'CREATE INDEX IF NOT EXISTS idx_bankroll_account_date ON bankroll(account_id, transaction_date)',
        
        # TRADE_STATUS_HISTORY TABLE
        'CREATE INDEX IF NOT EXISTS idx_trade_status_trade ON trade_status_history(trade_id)',
        'CREATE INDEX IF NOT EXISTS idx_trade_status_changed ON trade_status_history(changed_at DESC)',
    ]
    
    for index_sql in indexes:
        try:
            cursor.execute(index_sql)
        except sqlite3.OperationalError as e:
            # Index might already exist or column might not exist yet
            pass

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
                WHEN trade_type = 'SELL' THEN credit_debit 
                ELSE -credit_debit 
            END), 0) as total_premiums
            FROM trades
            WHERE trade_status != 'roll' AND account_id = ?
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
        # So: Margin Capital = (strike_price - (credit_debit - commission)) * (num_of_contracts * 100)
        # Calculate for options trades (not BTO/STC stock trades) that are open or assigned
        # Apply status filter if provided
        base_where = 'trade_status != \'roll\' AND account_id = ? AND trade_type NOT IN (\'BTO\', \'STC\') AND (trade_type LIKE \'%ROCT PUT\' OR trade_type LIKE \'%ROCT CALL\' OR trade_type LIKE \'ROCT%\' OR trade_type LIKE \'BTO CALL\' OR trade_type LIKE \'STC CALL\')'
        
        # Determine status condition
        if status_filter == 'open':
            status_condition = 'trade_status = \'open\''
        elif status_filter == 'completed':
            status_condition = 'trade_status = \'closed\''
        elif status_filter == 'assigned':
            status_condition = 'trade_status = \'assigned\''
        else:
            # Default: include both open and assigned
            status_condition = '(trade_status = \'open\' OR trade_status = \'assigned\')'
        
        query = f'''
            SELECT COALESCE(SUM(margin_capital), 0) as used
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
                SUM(margin_capital) as margin_capital
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

@app.route('/api/commissions', methods=['GET'])
def get_commissions():
    try:
        account_id = request.args.get('account_id', 9)
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT c.*, a.account_name
            FROM commissions c
            LEFT JOIN accounts a ON c.account_id = a.id
            WHERE c.account_id = ?
            ORDER BY c.effective_date DESC
        ''', (account_id,))
        
        commissions = cursor.fetchall()
        conn.close()
        
        return jsonify([dict(c) for c in commissions])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/commissions', methods=['POST'])
def create_commission():
    try:
        data = request.get_json()
        account_id = data.get('account_id', 9)
        commission_rate = float(data.get('commission_rate'))
        effective_date = data.get('effective_date')
        notes = data.get('notes', '')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO commissions 
            (account_id, commission_rate, effective_date, notes)
            VALUES (?, ?, ?, ?)
        ''', (account_id, commission_rate, effective_date, notes))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
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
        
        # Join with symbols table to get ticker and company name, and join with trade_types to get type_name
        cursor.execute('''
            SELECT st.*, s.ticker, s.company_name, tt.type_name
            FROM trades st 
            JOIN tickers s ON st.ticker_id = s.id 
            LEFT JOIN trade_types tt ON st.trade_type_id = tt.id
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
        
        # Check if symbol exists (case-insensitive)
        cursor.execute('SELECT id FROM tickers WHERE UPPER(ticker) = UPPER(?)', (ticker,))
        symbol_row = cursor.fetchone()
        
        if symbol_row:
            ticker_id = symbol_row['id']
        else:
            # Create new symbol (store as uppercase)
            cursor.execute('INSERT INTO tickers (ticker, company_name) VALUES (?, ?)', (ticker.upper(), ticker))
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
        
        # Get commission rate in effect at trade date
        cursor.execute('''
            SELECT commission_rate 
            FROM commissions 
            WHERE account_id = ? AND effective_date <= ?
            ORDER BY effective_date DESC
            LIMIT 1
        ''', (account_id, trade_date))
        
        commission_row = cursor.fetchone()
        commission = commission_row['commission_rate'] if commission_row else 0.0
        
        # Calculate margin_capital for options trades
        margin_capital = None
        if trade_type not in ['BTO', 'STC'] and strike_price > 0:
            # Margin capital = (strike_price - (premium - commission)) * num_of_contracts * 100
            margin_capital = (strike_price - (premium - commission)) * num_of_contracts * 100
        
        # Insert trade
        cursor.execute('''
            INSERT INTO trades 
            (account_id, ticker_id, trade_date, expiration_date, num_of_contracts, credit_debit, total_premium, 
             days_to_expiration, current_price, strike_price, trade_status, trade_type, 
             price_per_share, total_amount, commission_paid, margin_capital)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, trade_date, expiration_date, num_of_contracts, premium, total_premium,
              days_to_expiration, current_price, strike_price, 'open', trade_type,
              price_per_share, total_amount, commission, margin_capital))
        
        trade_id = cursor.lastrowid
        
        # Create cost basis entry for ALL trades
        if trade_type in ['BTO', 'STC']:
            create_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, trade_type, num_of_contracts, premium, total_premium)
        else:
            # Create cost basis entry for options trades (ROCT PUT, ROCT CALL, etc.)
            create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, trade_type, num_of_contracts, premium, strike_price, expiration_date)
        
        # Create cash flow entry for EVERY trade based on requires_contracts
        cash_flow_id = None
        
        # Check if this trade type requires contracts
        cursor.execute('SELECT requires_contracts FROM trade_types WHERE type_name = ?', (trade_type,))
        trade_type_row = cursor.fetchone()
        requires_contracts = trade_type_row['requires_contracts'] if trade_type_row else 0
        
        if requires_contracts == 1:
            # Options trade: create positive cash flow entry with transaction_type='OPTIONS'
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, trade_date, 'OPTIONS', round(premium * num_of_contracts * 100, 2), 
                  f"{trade_type} premium received", trade_id, ticker_id))
            cash_flow_id = cursor.lastrowid
        else:
            # For BTO/STC or other trade types that don't require contracts, still create a cash flow entry
            # Determine if it's a credit or debit based on trade type
            transaction_type = 'BUY' if trade_type == 'BTO' else 'SELL'
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, trade_date, transaction_type, round(total_premium, 2), 
                  f"{trade_type} {num_of_contracts} shares", trade_id, ticker_id))
            cash_flow_id = cursor.lastrowid
        
        # Update cost_basis entry to link to cash_flow if cash flow was created
        if cash_flow_id:
            cursor.execute('''
                UPDATE cost_basis SET cash_flow_id = ? WHERE trade_id = ? AND ticker_id = ? AND transaction_date = ?
            ''', (cash_flow_id, trade_id, ticker_id, trade_date))
        
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
    # Order by transaction_date DESC to get the most recent entry for THIS specific ticker
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
    
    # For STC, make total_amount negative (we receive proceeds, so it reduces our basis)
    if trade_type == 'STC':
        total_amount = -abs(total_amount)
    
    # Update running totals
    new_running_basis = running_basis + total_amount
    # For STC, subtract shares (we're selling). For BTO, add shares (we're buying)
    if trade_type == 'STC':
        new_running_shares = running_shares - num_of_contracts
    else:  # BTO
        new_running_shares = running_shares + num_of_contracts
    
    # For display: STC shares should be negative to show we sold them
    if trade_type == 'STC':
        display_shares = -num_of_contracts
    else:
        display_shares = num_of_contracts
    
    # Calculate basis per share
    basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
    
    # Insert cost basis entry
    cursor.execute('''
        INSERT INTO cost_basis 
        (account_id, ticker_id, trade_id, cash_flow_id, transaction_date, description, shares, cost_per_share, 
         total_amount, running_basis, running_shares, basis_per_share)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (account_id, ticker_id, trade_id, None, trade_date, description, display_shares, price_per_share,
          total_amount, new_running_basis, new_running_shares, basis_per_share))

def create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, trade_type, num_of_contracts, premium, strike_price, expiration_date):
    """Create cost basis entry for options trades (ROCT PUT, ROCT CALL, etc.)"""
    import sys
    print(f"create_options_cost_basis_entry: ticker_id={ticker_id}, account_id={account_id}, trade_date={trade_date}", file=sys.stderr)
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
        # - shares = 0 for all options trades (ROCT, ROP, ROC)
        # - cost_per_share = 0 (no cost per share for options)
        # - total_amount = premium * num_of_contracts * 100 (total premium collected, negative for SELL as we receive money)
        shares = 0  # No shares for all options trades (ROCT, ROP, ROC)
        cost_per_share = 0  # No cost per share for options trades
        total_amount = -(premium * num_of_contracts * 100)  # Total premium in dollars (negative because we receive premium)
        
        # Get current running totals for this account and ticker
        # Order by transaction_date DESC to get the most recent entry for THIS specific ticker
        cursor.execute('''
            SELECT running_basis, running_shares 
            FROM cost_basis 
            WHERE ticker_id = ? AND account_id = ?
            ORDER BY transaction_date DESC, rowid DESC
            LIMIT 1
        ''', (ticker_id, account_id))
        
        last_entry = cursor.fetchone()
        import sys
        print(f"Looking for prior entries: ticker_id={ticker_id}, account_id={account_id}, last_entry={last_entry}", file=sys.stderr)
        if last_entry:
            running_basis = last_entry['running_basis']
            running_shares = last_entry['running_shares']
            print(f"Found prior entry: running_basis={running_basis}, running_shares={running_shares}", file=sys.stderr)
        else:
            running_basis = 0
            running_shares = 0
            print(f"No prior entry found", file=sys.stderr)
        
        # Calculate basis per share
        # If this is the first entry (no prior entries), set running_basis to total_amount
        if last_entry is None:
            # First entry: basis should be the amount, and basis/share should be the amount
            new_running_basis = total_amount
            new_running_shares = shares
            basis_per_share = total_amount
            print(f"First entry for ticker: running_basis={new_running_basis}, total_amount={total_amount}", file=sys.stderr)
        else:
            # Update running totals (for options, shares represents contracts)
            new_running_basis = running_basis + total_amount
            new_running_shares = running_shares + shares  # Add contracts
            basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
            print(f"Subsequent entry: prior running_basis={running_basis}, total_amount={total_amount}, new_running_basis={new_running_basis}", file=sys.stderr)
        
        # Insert cost basis entry
        cursor.execute('''
            INSERT INTO cost_basis 
            (account_id, ticker_id, trade_id, cash_flow_id, transaction_date, description, shares, cost_per_share, 
             total_amount, running_basis, running_shares, basis_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, trade_id, None, trade_date, description, shares, cost_per_share,
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
            # Get or create symbol (case-insensitive)
            cursor.execute('SELECT id FROM tickers WHERE UPPER(ticker) = UPPER(?)', (ticker,))
            symbol_row = cursor.fetchone()
            
            if symbol_row:
                ticker_id = symbol_row['id']
            else:
                # Create new symbol (store as uppercase)
                cursor.execute('INSERT INTO tickers (ticker, company_name) VALUES (?, ?)', (ticker.upper(), ticker))
                ticker_id = cursor.lastrowid
            
            updates.append('ticker_id = ?')
            params.append(ticker_id)
        
        if 'tradeDate' in data:
            updates.append('trade_date = ?')
            params.append(data['tradeDate'])
        elif 'trade_date' in data:
            updates.append('trade_date = ?')
            params.append(data['trade_date'])
        
        if 'expirationDate' in data:
            updates.append('expiration_date = ?')
            params.append(data['expirationDate'])
        elif 'expiration_date' in data:
            updates.append('expiration_date = ?')
            params.append(data['expiration_date'])
        
        if 'num_of_contracts' in data:
            num_contracts = int(data['num_of_contracts'])
            updates.append('num_of_contracts = ?')
            params.append(num_contracts)
            # Recalculate total_premium when num_of_contracts changes
            # Get current credit_debit to calculate new total
            current_credit_debit = trade['credit_debit']
            new_total_premium = current_credit_debit * num_contracts
            updates.append('total_premium = ?')
            params.append(new_total_premium)
        
        if 'premium' in data or 'creditDebit' in data:
            credit_debit = float(data.get('premium') or data.get('creditDebit'))
            updates.append('credit_debit = ?')
            params.append(credit_debit)
            # Recalculate total_premium when credit_debit changes
            current_num_contracts = trade['num_of_contracts']
            new_total_premium = credit_debit * current_num_contracts
            updates.append('total_premium = ?')
            params.append(new_total_premium)
        
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
        new_status = data.get('status') or data.get('trade_status')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get current trade
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade = cursor.fetchone()
        
        if not trade:
            return jsonify({'error': 'Trade not found'}), 404
        
        old_status = trade['trade_status']
        
        # Update status
        cursor.execute('UPDATE trades SET trade_status = ? WHERE id = ?', (new_status, trade_id))
        
        # Record status change
        cursor.execute('''
            INSERT INTO trade_status_history (trade_id, old_status, new_status)
            VALUES (?, ?, ?)
        ''', (trade_id, old_status, new_status))
        
        # Handle assigned trades - create cost basis entry and cash flow entry
        if new_status == 'assigned' and old_status != 'assigned':
            create_assigned_cost_basis_entry(cursor, trade)
            
            # Create cash flow entry for the assignment
            # Convert Row to dict if needed
            trade_dict = dict(trade) if hasattr(trade, 'keys') and not isinstance(trade, dict) else trade
            account_id = trade_dict.get('account_id', 9)
            ticker_id = trade_dict['ticker_id']
            trade_date = trade_dict['trade_date']
            num_of_contracts = trade_dict['num_of_contracts']
            strike_price = trade_dict['strike_price']
            trade_type = trade_dict['trade_type']
            
            # Get ticker symbol for description
            cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
            ticker = cursor.fetchone()['ticker']
            
            # Calculate total amount based on trade type:
            # - PUTs (ROCT PUT, ROP): negative (we're being assigned to buy, money goes out)
            # - CALLs (ROCT CALL, ROC): positive (we're being assigned to sell, money comes in)
            shares = num_of_contracts * 100
            if 'PUT' in trade_type or 'ROP' in trade_type:
                # PUT assignment: negative amount (buying shares)
                total_amount = -(strike_price * shares)
                description = f"ASSIGNMENT: BUY {shares} {ticker} @ ${strike_price} (assigned PUT)"
            else:
                # CALL assignment: positive amount (selling shares)
                total_amount = strike_price * shares
                description = f"ASSIGNMENT: SELL {shares} {ticker} @ ${strike_price} (assigned CALL)"
            
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, trade_date, 'ASSIGNMENT', round(total_amount, 2), 
                  description, trade_id, ticker_id))
            cash_flow_id = cursor.lastrowid
            
            # Link the cost_basis entry to this cash flow
            cursor.execute('''
                UPDATE cost_basis SET cash_flow_id = ? 
                WHERE trade_id = ? AND account_id = ? AND ticker_id = ? AND transaction_date = ?
                AND description LIKE 'ASSIGNED%'
            ''', (cash_flow_id, trade_id, account_id, ticker_id, trade_date))
        
        # Handle unassigning - delete assigned cost basis entry
        elif old_status == 'assigned' and new_status != 'assigned':
            # Convert Row to dict if needed
            trade_dict = dict(trade) if hasattr(trade, 'keys') and not isinstance(trade, dict) else trade
            account_id = trade_dict.get('account_id', 9)
            ticker_id = trade_dict['ticker_id']
            
            # Delete assigned cost basis entries
            cursor.execute('''
                DELETE FROM cost_basis 
                WHERE trade_id = ? AND account_id = ? AND ticker_id = ?
                AND description LIKE 'ASSIGNED%'
            ''', (trade_id, account_id, ticker_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        print(f'Error updating trade status: {e}')
        print(f'Traceback: {traceback.format_exc()}')
        return jsonify({'error': f'Failed to update trade status: {str(e)}'}), 500

def create_assigned_cost_basis_entry(cursor, trade):
    """Create cost basis entry for assigned trades"""
    print(f"Creating assigned cost basis entry for trade: {trade}")
    # Convert Row to dict for easier access
    trade_dict = dict(trade) if isinstance(trade, sqlite3.Row) else trade
    account_id = trade_dict.get('account_id', 9)  # Default to Rule One
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
        return
    
    # Get current running totals BEFORE creating the assigned entry
    # Use rowid to get the most recently inserted entry
    cursor.execute('''
        SELECT running_basis, running_shares 
        FROM cost_basis 
        WHERE ticker_id = ? AND account_id = ?
        ORDER BY rowid DESC 
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
    ticker = cursor.fetchone()['ticker']
    
    # Use expiration date as the transaction date for assigned trades
    assigned_trade_date = trade_dict['expiration_date']
    
    # Format expiration date
    exp_date = datetime.strptime(trade_dict['expiration_date'], '%Y-%m-%d').strftime('%d-%b-%y').upper()
    
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
    
    # Get current running totals for this account and ticker
    # Update running totals (running_basis and running_shares already retrieved above)
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

@app.route('/api/trades/<int:trade_id>/field', methods=['PUT'])
def update_trade_field(trade_id):
    try:
        data = request.get_json()
        field = data['field']
        value = data['value']
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Validate field name
        valid_fields = ['num_of_contracts', 'credit_debit', 'strike_price', 'trade_status']
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
        
        # Search in tickers table (case-insensitive)
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Search for tickers that start with or contain the query
        cursor.execute('''
            SELECT DISTINCT ticker, company_name 
            FROM tickers 
            WHERE UPPER(ticker) LIKE ? OR UPPER(company_name) LIKE ?
            ORDER BY ticker
            LIMIT 20
        ''', (f'%{query}%', f'%{query}%'))
        
        results = cursor.fetchall()
        conn.close()
        
        companies = []
        for row in results:
            companies.append({
                'symbol': row['ticker'].upper(),  # Ensure uppercase
                'name': row['company_name'] or row['ticker'].upper()  # Use company_name or fallback to ticker
            })
        
        return jsonify(companies)
    except Exception as e:
        print(f'Error searching tickers: {e}')
        return jsonify([])

@app.route('/api/company-info/<ticker>')
def get_company_info(ticker):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # First check if we have the company name cached in database
        cursor.execute('SELECT company_name FROM tickers WHERE ticker = ?', (ticker.upper(),))
        ticker_row = cursor.fetchone()
        
        if ticker_row and ticker_row['company_name'] and ticker_row['company_name'] != ticker.upper():
            # Return cached value
            conn.close()
            return jsonify({
                'symbol': ticker.upper(),
                'name': ticker_row['company_name']
            })
        
        # Not cached, fetch from Alpha Vantage API
        api_key = os.environ.get('ALPHA_VANTAGE_API_KEY')
        if not api_key:
            conn.close()
            return jsonify({'error': 'Alpha Vantage API key not configured'}), 500
        
        # Use Alpha Vantage Symbol Search API to get company info
        url = f'https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords={ticker}&apikey={api_key}'
        
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        
        if 'Error Message' in data:
            conn.close()
            return jsonify({'error': data['Error Message']}), 500
        
        if 'Note' in data:
            # Rate limit exceeded - mark ticker as pending and return ticker as name
            # Check if ticker exists
            cursor.execute('SELECT company_name FROM tickers WHERE ticker = ?', (ticker.upper(),))
            existing = cursor.fetchone()
            
            if not existing:
                # Create ticker with pending flag (company_name = NULL indicates pending)
                cursor.execute('''
                    INSERT INTO tickers (ticker, company_name, needs_update)
                    VALUES (?, NULL, 1)
                ''', (ticker.upper(),))
                conn.commit()
            
            conn.close()
            return jsonify({
                'symbol': ticker.upper(),
                'name': ticker,
                'pending': True
            })
        
        company_name = ticker  # Default fallback
        # Find exact match for the ticker
        if 'bestMatches' in data:
            for match in data['bestMatches']:
                if match['1. symbol'].upper() == ticker.upper():
                    company_name = match['2. name']
                    
                    # Cache the result in database
                    cursor.execute('''
                        UPDATE tickers 
                        SET company_name = ?, needs_update = 0
                        WHERE ticker = ?
                    ''', (company_name, ticker.upper()))
                    
                    # If ticker doesn't exist, create it
                    if cursor.rowcount == 0:
                        cursor.execute('''
                            INSERT INTO tickers (ticker, company_name, needs_update)
                            VALUES (?, ?, 0)
                        ''', (ticker.upper(), company_name))
                    
                    conn.commit()
                    break
        
        conn.close()
        return jsonify({
            'symbol': ticker.upper(),
            'name': company_name
        })
    except requests.exceptions.RequestException as e:
        print(f'Error fetching company info from Alpha Vantage: {e}')
        return jsonify({'symbol': ticker, 'name': ticker})
    except Exception as e:
        print(f'Error getting company info: {e}')
        return jsonify({'symbol': ticker, 'name': ticker})

@app.route('/api/pending-tickers/update', methods=['POST'])
def update_pending_tickers():
    """Update company names for tickers marked as needing update"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all tickers that need updating
        cursor.execute('SELECT ticker FROM tickers WHERE needs_update = 1 LIMIT 10')
        pending_tickers = cursor.fetchall()
        
        if not pending_tickers:
            conn.close()
            return jsonify({'updated': 0, 'message': 'No pending tickers'})
        
        api_key = os.environ.get('ALPHA_VANTAGE_API_KEY')
        if not api_key:
            conn.close()
            return jsonify({'error': 'Alpha Vantage API key not configured'}), 500
        
        updated_count = 0
        for ticker_row in pending_tickers:
            ticker = ticker_row['ticker']
            
            try:
                url = f'https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords={ticker}&apikey={api_key}'
                response = requests.get(url, timeout=10)
                
                if response.status_code == 200:
                    data = response.json()
                    
                    if 'Note' not in data and 'Error Message' not in data:
                        if 'bestMatches' in data:
                            for match in data['bestMatches']:
                                if match['1. symbol'].upper() == ticker.upper():
                                    company_name = match['2. name']
                                    cursor.execute('''
                                        UPDATE tickers 
                                        SET company_name = ?, needs_update = 0
                                        WHERE ticker = ?
                                    ''', (company_name, ticker))
                                    conn.commit()
                                    updated_count += 1
                                    break
            except Exception as e:
                print(f'Error updating {ticker}: {e}')
                continue
        
        conn.close()
        return jsonify({
            'updated': updated_count,
            'message': f'Updated {updated_count} tickers'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/top-symbols')
def get_top_symbols():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get top 10 most commonly used ticker symbols with status information
        cursor.execute('''
            SELECT t.ticker, COUNT(st.id) as trade_count,
                   MAX(CASE WHEN st.trade_status = 'open' THEN 1 ELSE 0 END) as has_open_trades,
                   MAX(CASE WHEN st.trade_status IN ('assigned', 'expired') THEN st.trade_date ELSE NULL END) as last_assigned_expired_date
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
        
        # Query cost_basis table directly instead of trades table
        if ticker:
            cursor.execute('''
                SELECT cb.*, t.ticker, tr.trade_status as status
                FROM cost_basis cb
                JOIN tickers t ON cb.ticker_id = t.id
                LEFT JOIN trades tr ON cb.trade_id = tr.id
                WHERE t.ticker = ? AND t.ticker IS NOT NULL AND t.ticker != ""
                ORDER BY cb.transaction_date ASC
            ''', (ticker,))
        else:
            cursor.execute('''
                SELECT cb.*, t.ticker, tr.trade_status as status
                FROM cost_basis cb
                JOIN tickers t ON cb.ticker_id = t.id
                LEFT JOIN trades tr ON cb.trade_id = tr.id
                WHERE t.ticker IS NOT NULL AND t.ticker != ""
                ORDER BY t.ticker, cb.transaction_date ASC
            ''')
        
        cost_basis_entries = cursor.fetchall()
        
        # Convert to list of dicts for processing
        entries = [dict(entry) for entry in cost_basis_entries]
        
        # Group entries by ticker
        ticker_groups = {}
        for entry in entries:
            ticker = entry['ticker']
            if ticker not in ticker_groups:
                ticker_groups[ticker] = {
                    'trades': []
                }
            ticker_groups[ticker]['trades'].append(entry)
        
        result = []
        for ticker, ticker_data in ticker_groups.items():
            entries_list = ticker_data['trades']
            
            # Get company name from database first (cached)
            cursor.execute('SELECT company_name FROM tickers WHERE ticker = ?', (ticker,))
            ticker_row = cursor.fetchone()
            
            if ticker_row and ticker_row['company_name']:
                company_name = ticker_row['company_name']
            else:
                # If not cached, fetch from Alpha Vantage API and cache it
                company_name = ticker  # Default fallback
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
                                        # Cache the company name in database
                                        cursor.execute('''
                                            UPDATE tickers 
                                            SET company_name = ? 
                                            WHERE ticker = ?
                                        ''', (company_name, ticker))
                                        conn.commit()
                                        break
                                else:
                                    company_name = ticker
                            else:
                                company_name = ticker
                        else:
                            company_name = ticker
                    else:
                        company_name = ticker
                except Exception as e:
                    company_name = ticker
                    print(f'Error fetching company name for {ticker}: {e}')
            
            # Map cost_basis entries to trade structure
            mapped_trades = []
            for entry in entries_list:
                trade = {
                    'id': entry.get('id'),
                    'trade_date': entry.get('transaction_date'),
                    'trade_description': entry.get('description'),
                    'shares': entry.get('shares'),
                    'cost_per_share': entry.get('cost_per_share'),
                    'amount': entry.get('total_amount'),
                    'running_basis': entry.get('running_basis'),
                    'running_basis_per_share': entry.get('basis_per_share'),
                    'running_shares': entry.get('running_shares'),
                    'status': entry.get('status')  # From linked trade
                }
                mapped_trades.append(trade)
            
            # Calculate totals from the last entry (which has the running totals)
            if mapped_trades:
                last_entry = mapped_trades[-1]
                total_shares = last_entry['running_shares']
                total_cost_basis = last_entry['running_basis']
                # Use the calculated basis_per_share from the last entry (always use it, even if shares is 0)
                total_cost_basis_per_share = last_entry['running_basis_per_share']
            else:
                total_shares = 0
                total_cost_basis = 0
                total_cost_basis_per_share = 0
            
            result.append({
                'ticker': ticker,
                'company_name': company_name,
                'total_shares': total_shares,
                'total_cost_basis': total_cost_basis,
                'total_cost_basis_per_share': total_cost_basis_per_share,
                'trades': mapped_trades
            })
        
        conn.close()
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
            AND st.trade_status != "roll"
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
        
        # Calculate total_net_credit from cash_flows where transaction_type='OPTIONS'
        cash_flow_query = '''
            SELECT SUM(amount) as total_net_credit
            FROM cash_flows
            WHERE transaction_type = 'OPTIONS'
        '''
        cash_flow_params = []
        
        if start_date:
            cash_flow_query += ' AND transaction_date >= ?'
            cash_flow_params.append(start_date)
        
        if end_date:
            cash_flow_query += ' AND transaction_date <= ?'
            cash_flow_params.append(end_date)
        
        cursor.execute(cash_flow_query, cash_flow_params)
        result = cursor.fetchone()
        total_net_credit = result['total_net_credit'] if result['total_net_credit'] is not None else 0
        
        conn.close()
        
        # Calculate summary statistics
        total_trades = len(trades)
        open_trades = len([t for t in trades if t['trade_status'] == 'open'])
        closed_trades = len([t for t in trades if t['trade_status'] in ['closed', 'expired', 'assigned']])
        
        # Calculate wins and losses only from completed trades
        completed_trades_list = [t for t in trades if t['trade_status'] in ['closed', 'expired', 'assigned']]
        wins = len([t for t in completed_trades_list if t['total_premium'] > 0])
        losses = len([t for t in completed_trades_list if t['total_premium'] < 0])
        winning_percentage = (wins / len(completed_trades_list) * 100) if len(completed_trades_list) > 0 else 0
        
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
        
        # Build query with date filters - sum only OPTIONS cash_flows.amount grouped by transaction_date
        query = '''
            SELECT transaction_date, SUM(amount) as daily_premium
            FROM cash_flows
            WHERE transaction_type = 'OPTIONS'
        '''
        params = []
        
        if start_date:
            query += ' AND transaction_date >= ?'
            params.append(start_date)
        
        if end_date:
            query += ' AND transaction_date <= ?'
            params.append(end_date)
        
        query += ' GROUP BY transaction_date ORDER BY transaction_date'
        
        cursor.execute(query, params)
        data = cursor.fetchall()
        conn.close()
        
        chart_data = []
        for row in data:
            # Format date as MM/DD
            date_obj = datetime.strptime(row['transaction_date'], '%Y-%m-%d')
            formatted_date = date_obj.strftime('%m/%d')
            
            chart_data.append({
                'date': formatted_date,
                'premium': row['daily_premium']
            })
        
        return jsonify(chart_data)
    except Exception as e:
        print(f'Error fetching chart data: {e}')
        return jsonify({'error': 'Failed to fetch chart data'}), 500

@app.route('/api/repopulate-cash-flows', methods=['POST'])
def repopulate_cash_flows():
    """Reset cash_flows table and repopulate from trades table"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Clear all existing cash flows
        cursor.execute('DELETE FROM cash_flows')
        print("Cleared cash_flows table", flush=True)
        
        # Get all trades
        cursor.execute('''
            SELECT t.*, tt.requires_contracts 
            FROM trades t
            LEFT JOIN trade_types tt ON t.trade_type = tt.type_name
        ''')
        trades = cursor.fetchall()
        
        print(f"Found {len(trades)} trades to process", flush=True)
        
        created_count = 0
        
        for trade in trades:
            trade_dict = dict(trade)
            account_id = trade_dict.get('account_id', 9)
            ticker_id = trade_dict['ticker_id']
            trade_date = trade_dict['trade_date']
            trade_id = trade_dict['id']
            premium = trade_dict['credit_debit']
            num_of_contracts = trade_dict['num_of_contracts']
            trade_type = trade_dict['trade_type']
            trade_status = trade_dict['trade_status']
            strike_price = trade_dict['strike_price']
            requires_contracts = trade_dict.get('requires_contracts', 0)
            
            # Get ticker symbol
            cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
            ticker_result = cursor.fetchone()
            ticker = ticker_result['ticker'] if ticker_result else 'UNKNOWN'
            
            # Create cash flow entry for the initial trade
            if requires_contracts == 1:
                # Options trade: create positive cash flow entry
                amount = premium * num_of_contracts * 100
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (account_id, trade_date, 'OPTIONS', round(amount, 2), 
                      f"{trade_type} premium received", trade_id, ticker_id))
            else:
                # Non-options trade: create BUY/SELL entry
                amount = trade_dict.get('total_premium', premium * num_of_contracts)
                transaction_type = 'BUY' if trade_type == 'BTO' else 'SELL'
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (account_id, trade_date, transaction_type, round(amount, 2), 
                      f"{trade_type} {num_of_contracts} shares", trade_id, ticker_id))
            
            created_count += 1
            
            # If trade is assigned, create ASSIGNMENT cash flow entry
            if trade_status == 'assigned':
                shares = num_of_contracts * 100
                if 'PUT' in trade_type or 'ROP' in trade_type:
                    # PUT assignment: negative amount (buying shares)
                    assignment_amount = -(strike_price * shares)
                    description = f"ASSIGNMENT: BUY {shares} {ticker} @ ${strike_price} (assigned PUT)"
                else:
                    # CALL assignment: positive amount (selling shares)
                    assignment_amount = strike_price * shares
                    description = f"ASSIGNMENT: SELL {shares} {ticker} @ ${strike_price} (assigned CALL)"
                
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (account_id, trade_date, 'ASSIGNMENT', round(assignment_amount, 2), 
                      description, trade_id, ticker_id))
                created_count += 1
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True, 
            'message': f'Repopulated cash_flows with {created_count} entries from {len(trades)} trades'
        })
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'Error repopulating cash flows: {e}')
        print(f'Traceback: {error_detail}')
        return jsonify({'error': f'Failed to repopulate cash flows: {str(e)}'}), 500

@app.route('/api/repopulate-cost-basis', methods=['POST'])
def repopulate_cost_basis():
    """Repopulate cost_basis entries for assigned trades and link to cash_flows"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all assigned trades
        cursor.execute('''
            SELECT t.*, tick.ticker 
            FROM trades t
            JOIN tickers tick ON t.ticker_id = tick.id
            WHERE t.trade_status = 'assigned'
        ''')
        assigned_trades = cursor.fetchall()
        
        print(f"Found {len(assigned_trades)} assigned trades", flush=True)
        
        linked_count = 0
        created_count = 0
        
        for trade in assigned_trades:
            trade_dict = dict(trade)
            account_id = trade_dict.get('account_id', 9)
            ticker_id = trade_dict['ticker_id']
            trade_id = trade_dict['id']
            trade_date = trade_dict['trade_date']
            trade_type = trade_dict['trade_type']
            num_of_contracts = trade_dict['num_of_contracts']
            strike_price = trade_dict['strike_price']
            expiration_date = trade_dict['expiration_date']
            
            # Check if cost_basis entry exists for this assignment
            cursor.execute('''
                SELECT id, cash_flow_id FROM cost_basis
                WHERE trade_id = ? AND account_id = ? AND ticker_id = ?
                AND description LIKE 'ASSIGNED%'
            ''', (trade_id, account_id, ticker_id))
            cost_basis_entry = cursor.fetchone()
            
            # Find the ASSIGNMENT cash flow for this trade
            cursor.execute('''
                SELECT id FROM cash_flows
                WHERE trade_id = ? AND transaction_type = 'ASSIGNMENT'
            ''', (trade_id,))
            assignment_cash_flow = cursor.fetchone()
            
            if assignment_cash_flow:
                cash_flow_id = assignment_cash_flow['id']
                
                if cost_basis_entry:
                    # Update existing cost_basis entry to link to cash flow
                    if not cost_basis_entry['cash_flow_id']:
                        cursor.execute('''
                            UPDATE cost_basis SET cash_flow_id = ?
                            WHERE id = ?
                        ''', (cash_flow_id, cost_basis_entry['id']))
                        linked_count += 1
                        print(f"Linked cost_basis {cost_basis_entry['id']} to cash_flow {cash_flow_id} for trade {trade_id}", flush=True)
                else:
                    # Create missing cost_basis entry for this assignment
                    print(f"Creating missing cost_basis entry for trade {trade_id}", flush=True)
                    create_assigned_cost_basis_entry(cursor, trade_dict)
                    created_count += 1
                    
                    # Now link it to the cash flow
                    cursor.execute('''
                        UPDATE cost_basis SET cash_flow_id = ?
                        WHERE trade_id = ? AND account_id = ? AND ticker_id = ?
                        AND description LIKE 'ASSIGNED%'
                    ''', (cash_flow_id, trade_id, account_id, ticker_id))
                    linked_count += 1
            else:
                print(f"No ASSIGNMENT cash flow found for trade {trade_id}", flush=True)
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': f'Linked {linked_count} cost_basis entries and created {created_count} new entries for {len(assigned_trades)} assigned trades'
        })
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'Error repopulating cost basis: {e}')
        print(f'Traceback: {error_detail}')
        return jsonify({'error': f'Failed to repopulate cost basis: {str(e)}'}), 500

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
        
        # Get current working directory (detect if on PythonAnywhere or local)
        current_dir = os.getcwd()
        
        # For local development
        if 'pythonanywhere' not in current_dir.lower():
            project_dir = current_dir
        else:
            # For PythonAnywhere
            project_dir = '/home/greenmangroup/cursor_tracker/stock-options-tracker/stock-options-tracker'
        
        print(f"Deploying from: {project_dir}")
        
        # Force checkout to overwrite local changes to trades.db
        print("Force checking out trades.db...")
        checkout_result = subprocess.run(['git', 'checkout', '--force', 'HEAD', '--', 'trades.db'], 
                                        cwd=project_dir, 
                                        capture_output=True, 
                                        text=True)
        
        # Clean and fetch
        print("Cleaning working directory...")
        subprocess.run(['git', 'clean', '-fd'], 
                      cwd=project_dir, 
                      capture_output=True, 
                      text=True)
        
        print("Fetching latest code...")
        fetch_result = subprocess.run(['git', 'fetch', 'origin'], 
                                     cwd=project_dir, 
                                     capture_output=True, 
                                     text=True)
        
        if fetch_result.returncode == 0:
            print("✓ Fetched latest code")
        
        # Reset to origin/main
        print("Resetting to origin/main...")
        result = subprocess.run(['git', 'reset', '--hard', 'origin/main'], 
                               cwd=project_dir, 
                               capture_output=True, 
                               text=True)
        
        if result.returncode == 0:
            print(f"✓ Reset to origin/main: {result.stdout}")
            print(f"Deployment successful: {result.stdout}")
            
            # Reload WSGI application (for PythonAnywhere)
            wsgi_file = '/var/www/stockoptionstracker_pythonanywhere_com_wsgi.py'
            if os.path.exists(wsgi_file):
                os.utime(wsgi_file, None)
                print("✓ Reloaded WSGI application")
            
            # Also try alternative WSGI path
            alt_wsgi = '/var/www/greenmangroup_pythonanywhere_com_wsgi.py'
            if os.path.exists(alt_wsgi):
                os.utime(alt_wsgi, None)
                print("✓ Reloaded alternative WSGI application")
            
            # After deployment, automatically repopulate database tables
            # Wait a moment for the app to reload
            import time
            time.sleep(2)
            
            messages = []
            try:
                # Repopulate cash_flows
                print("Repopulating cash_flows table...")
                cash_flow_result = subprocess.run([
                    'curl', '-X', 'POST', 
                    'http://prometheusprograms.pythonanywhere.com/api/repopulate-cash-flows'
                ], capture_output=True, text=True, timeout=30)
                
                if cash_flow_result.returncode == 0:
                    print(f"✓ Cash flows repopulated")
                    messages.append("Cash flows repopulated")
                else:
                    print(f"Warning: Could not repopulate cash flows: {cash_flow_result.stderr}")
                    messages.append("Cash flows: skipped")
            except Exception as e:
                print(f"Warning: Could not repopulate cash flows: {e}")
                messages.append("Cash flows: skipped")
            
            try:
                # Repopulate cost_basis
                print("Repopulating cost_basis table...")
                cost_basis_result = subprocess.run([
                    'curl', '-X', 'POST',
                    'http://prometheusprograms.pythonanywhere.com/api/repopulate-cost-basis'
                ], capture_output=True, text=True, timeout=30)
                
                if cost_basis_result.returncode == 0:
                    print(f"✓ Cost basis repopulated")
                    messages.append("Cost basis repopulated")
                else:
                    print(f"Warning: Could not repopulate cost basis: {cost_basis_result.stderr}")
                    messages.append("Cost basis: skipped")
            except Exception as e:
                print(f"Warning: Could not repopulate cost basis: {e}")
                messages.append("Cost basis: skipped")
            
            message = f"Deployment successful. {'; '.join(messages)}"
            return jsonify({'success': True, 'message': message, 'output': result.stdout}), 200
        else:
            print(f"Git reset failed: {result.stderr}")
            return jsonify({'success': False, 'error': result.stderr}), 500
            
    except Exception as e:
        import traceback
        print(f"Webhook deployment error: {e}")
        print(traceback.format_exc())
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/recalculate-cost-basis', methods=['POST'])
def recalculate_cost_basis():
    """Recalculate cost basis entries for all existing trades"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all trades - ORDER BY trade_date to process in chronological order
        cursor.execute('''
            SELECT * FROM trades ORDER BY trade_date ASC
        ''')
        trades = cursor.fetchall()
        
        # Delete all existing cost basis entries
        cursor.execute('DELETE FROM cost_basis')
        
        # Recreate cost basis entries for each trade
        for trade in trades:
            trade_dict = dict(trade)
            trade_id = trade_dict['id']
            trade_type = trade_dict['trade_type']
            trade_date = trade_dict['trade_date']
            num_of_contracts = trade_dict['num_of_contracts']
            premium = trade_dict['premium']
            account_id = trade_dict['account_id']
            ticker_id = trade_dict['ticker_id']
            
            if trade_type in ['BTO', 'STC']:
                # For BTO/STC, we need to get the purchase price
                total_amount = premium * num_of_contracts
                create_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, 
                                       trade_type, num_of_contracts, premium, total_amount)
            else:
                # For options trades
                strike_price = trade_dict['strike_price']
                expiration_date = trade_dict['expiration_date']
                create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, trade_date, 
                                               trade_type, num_of_contracts, premium, strike_price, expiration_date)
        
        # Create assigned cost basis entries for trades with status='assigned'
        cursor.execute('SELECT * FROM trades WHERE status = "assigned"')
        assigned_trades = cursor.fetchall()
        
        for trade in assigned_trades:
            trade_dict = dict(trade)
            # Only create if it's an options trade (not BTO/STC)
            if trade_dict['trade_type'] not in ['BTO', 'STC']:
                create_assigned_cost_basis_entry(cursor, trade_dict)
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'message': f'Recalculated cost basis for {len(trades)} trades'})
    except Exception as e:
        import traceback
        print(f'Error recalculating cost basis: {e}')
        print(f'Traceback: {traceback.format_exc()}')
        return jsonify({'error': f'Failed to recalculate cost basis: {str(e)}'}), 500

@app.route('/api/import-excel', methods=['POST'])
def import_excel():
    """Import trades from Excel file using OKW format"""
    import zipfile
    import re
    import tempfile
    from xml.etree import ElementTree as ET
    
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'No file provided'}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'success': False, 'error': 'No file selected'}), 400
        
        # No limit on number of trades - import all
        
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp_file:
            file.save(tmp_file.name)
            excel_path = tmp_file.name
        
        try:
            # Read workbook XML using the original working approach
            import zipfile
            import re
            from xml.etree import ElementTree as ET
            
            print(f"Reading Excel file: {file.filename}", flush=True)
            print(f"Temporary file path: {excel_path}", flush=True)
            
            with zipfile.ZipFile(excel_path, "r") as z:
                # Shared strings for Excel text values
                shared_strings = []
                if "xl/sharedStrings.xml" in z.namelist():
                    shared_xml = ET.parse(z.open("xl/sharedStrings.xml"))
                    shared_strings = [t.text for t in shared_xml.findall(".//{*}t")]
                
                # Find the first sheet (use it as default)
                wb = ET.parse(z.open("xl/workbook.xml"))
                sheets = wb.findall(".//{*}sheet")
                if not sheets:
                    raise ValueError("Couldn't find any sheets in the workbook")
                
                # Use the first sheet
                sheet_index = 1
                sheet_name = sheets[0].attrib.get("name", "Sheet1")
                print(f"Reading from first sheet: '{sheet_name}' (sheet index {sheet_index})", flush=True)
                
                sheet_xml = ET.parse(z.open(f"xl/worksheets/sheet{sheet_index}.xml"))
                
                def cell_value(c):
                    v = c.find("{*}v")
                    if v is None:
                        return ""
                    if c.attrib.get("t") == "s":
                        idx = int(v.text)
                        return shared_strings[idx] if idx < len(shared_strings) else ""
                    return v.text
                
                def col_num(ref):
                    m = re.match(r"([A-Z]+)", ref)
                    if not m:
                        return 1
                    col = m.group(1)
                    n = 0
                    for ch in col:
                        n = n * 26 + (ord(ch) - 64)
                    return n
                
                # Collect all rows from the sheet
                rows = {}
                for r in sheet_xml.findall(".//{*}row"):
                    idx = int(r.attrib["r"])
                    row_cells = {}
                    for c in r.findall("{*}c"):
                        ref = c.attrib.get("r")
                        if not ref:
                            continue
                        col = col_num(ref)
                        if col >= 5:  # read only from column E onward
                            val = cell_value(c)
                            row_cells[col] = val
                            # Check if this is ASSIGNED or EXPIRED
                            if idx <= 60 and col <= 20 and ("ASSIGNED" in str(val).upper() or "EXPIRED" in str(val).upper()):
                                print(f"Found ASSIGNED/EXPIRED at row {idx}, col {col}: '{val}'", flush=True)
                    if row_cells:
                        rows[idx] = row_cells
                
                print(f"Collected {len(rows)} rows from Excel", flush=True)
            
            # Debug: Check row 57
            if False:  # Placeholder for old commented code
                pass
            if False:
                import zipfile
                import re
                from xml.etree import ElementTree as ET
                with zipfile.ZipFile(excel_path, "r") as z:
                    # Shared strings for Excel text values
                    shared_strings = []
                if "xl/sharedStrings.xml" in z.namelist():
                    shared_xml = ET.parse(z.open("xl/sharedStrings.xml"))
                    shared_strings = [t.text for t in shared_xml.findall(".//{*}t")]
                
                # Find the first sheet (use it as default)
                wb = ET.parse(z.open("xl/workbook.xml"))
                sheets = wb.findall(".//{*}sheet")
                if not sheets:
                    raise ValueError("Couldn't find any sheets in the workbook")
                
                # Use the first sheet
                sheet_index = 1
                sheet_name = sheets[0].attrib.get("name", "Sheet1")
                print(f"Reading from first sheet: '{sheet_name}' (sheet index {sheet_index})", flush=True)
                print(f"Total sheets found: {len(sheets)}", flush=True)
                
                sheet_xml = ET.parse(z.open(f"xl/worksheets/sheet{sheet_index}.xml"))
                
                def cell_value(c):
                    v = c.find("{*}v")
                    if v is None:
                        return ""
                    if c.attrib.get("t") == "s":
                        idx = int(v.text)
                        return shared_strings[idx] if idx < len(shared_strings) else ""
                    return v.text
                
                def col_num(ref):
                    m = re.match(r"([A-Z]+)", ref)
                    if not m:
                        return 1
                    col = m.group(1)
                    n = 0
                    for ch in col:
                        n = n * 26 + (ord(ch) - 64)
                    return n
                
                # Collect all rows from the sheet
                rows = {}
                for r in sheet_xml.findall(".//{*}row"):
                    idx = int(r.attrib["r"])
                    row_cells = {}
                    for c in r.findall("{*}c"):
                        ref = c.attrib.get("r")
                        if not ref:
                            continue
                        col = col_num(ref)
                        if col >= 5:  # read only from column E onward
                            row_cells[col] = cell_value(c)
                    if row_cells:
                        rows[idx] = row_cells
                
                print(f"Collected {len(rows)} rows from Excel", flush=True)
            
            # Debug: Check row 1
            if 1 in rows:
                print(f"Row 1 has columns: {sorted(list(rows[1].keys()))[:15]}", flush=True)
                for col in sorted(rows[1].keys())[:10]:
                    print(f"  Row 1, col {col} (letter={chr(64+col)}): '{rows[1][col]}'", flush=True)
            
            # Check what's in row 56 (one above row 57)
            if 56 in rows:
                print(f"Row 56 sample:", flush=True)
                for col in sorted(rows[56].keys())[:10]:
                    print(f"  Row 56, col {col}: '{rows[56][col]}'", flush=True)
            
            # Debug: Check row 57
            if 57 in rows:
                logging.info(f"Row 57 has {len(rows[57])} columns")
                logging.info(f"Row 57 column indices: {sorted(list(rows[57].keys()))}")
                for col in sorted(rows[57].keys())[:20]:
                    logging.info(f"  Row 57, col {col} (letter={chr(64+col)}): '{rows[57][col]}'")
            
            # Debug: Check row 65
            if 65 in rows:
                logging.info(f"Row 65 has {len(rows[65])} columns")
                logging.info(f"Row 65 column indices: {sorted(list(rows[65].keys()))}")
                for col in sorted(rows[65].keys())[:20]:
                    logging.info(f"  Row 65, col {col} (letter={chr(64+col)}): '{rows[65][col]}'")
            
            # Debug: Check row 4 for trade status in trade columns (5, 7, 9, 11, 13...)
            print("\n=== CHECKING ROW 4 FOR TRADE STATUS ===", flush=True)
            if 4 in rows:
                trade_cols_1 = sorted(rows[1].keys())[:10]  # First 10 trade columns
                for col in trade_cols_1:
                    status_val = rows[4].get(col, '')
                    print(f"Row 4, col {col}: '{status_val}'", flush=True)
            
            # Print requested rows in trade columns
            logging.info("\n=== ROW DATA IN COLUMNS 5, 7, 9 ===")
            for row_num in [1, 3, 5, 8, 41, 52, 54, 57, 61, 64, 65]:
                if row_num in rows:
                    logging.info(f"\nRow {row_num}:")
                    for col in [5, 7, 9]:
                        val = rows[row_num].get(col, '')
                        logging.info(f"  Col {col}: '{val}'")
            
            # Print ALL non-empty values in row 64 to see what's actually there
            logging.info("\n=== ALL ROW 64 VALUES (first 30 non-empty) ===")
            if 64 in rows:
                row_64_all = rows[64]
                non_empty = [(col, val) for col, val in sorted(row_64_all.items()) if val]
                for col, val in non_empty[:30]:
                    logging.info(f"  Col {col}: '{val}'")
            
            # Define fixed row mappings (Excel row -> database field)
            # Data starts in column E (column 5), each row represents one trade
            # Row 1 contains "TICKER TRADE_TYPE" - extract both ticker and trade_type from it
            mapping = {
                1:  "trade_type_raw",  # Row 1 -> Format: "SLV ROCT CALL" -> Extract "SLV" as ticker, "ROCT CALL" as trade_type
                3:  "trade_date",      # Row 3 -> trades.trade_date  
                5:  "current_price",   # Row 5 -> trades.current_price
                8:  "expiration_date",  # Row 8 -> trades.expiration_date
                15: "strike_price",     # Row 15 -> trades.strike_price (short strike)
                21: "credit_debit",     # Row 21 -> trades.credit_debit
                41: "num_of_contracts", # Row 41 -> trades.num_of_contracts
                64: "trade_status",     # Row 64 -> trades.trade_status (dropdown: open, expired, closed, roll, assigned)
            }

            # Build trade columns from row 1 (trade_type_raw)
            trade_type_row = rows.get(1, {})
            trade_cols = sorted(trade_type_row.keys())
            
            # Use ALL columns where row 1 has data
            # Row 64 will provide trade_status when available, otherwise it will be empty (defaults to 'open')
            trade_status_row = rows.get(64, {})
            
            print(f"Row 1 has {len(trade_cols)} columns: {trade_cols[:10]}...")
            print(f"Row 64 has {len(trade_status_row)} columns: {sorted(trade_status_row.keys())[:10]}...")
            print(f"Importing all trades from row 1", flush=True)

            # Build a dataframe column by column
            # Only include columns where row 1 has a value (skip empty metadata columns)
            # Row 64 provides trade_status when available
            data = {field: [] for field in mapping.values()}
            collected_cols = []
            
            for c in trade_cols:
                # Check if row 1 has data in this column (trade_type_raw)
                if 1 in rows and c in rows[1] and rows[1][c]:
                    collected_cols.append(c)
                    for r, field in mapping.items():
                        # For trade_status (row 64), use the value from trade_status_row
                        # If not present in row 64, it will be empty string (will default to 'open' later)
                        if field == "trade_status":
                            val = trade_status_row.get(c, "")
                        else:
                            val = rows.get(r, {}).get(c, "")
                        data[field].append(val)
                        # Debug: Check if row 64 has data
                        if r == 64 and field == "trade_status":
                            status_msg = f"'{val}'" if val else "'EMPTY - will default to open'"
                            print(f"Trade status from column {c} (row 64): {status_msg}", flush=True)
            
            df = pd.DataFrame(data)
            
            print(f"Collected {len(collected_cols)} columns: {collected_cols[:5]}...")
            
            # Debug: Check what row 57 has
            if 57 in rows:
                logging.info(f"Row 57 data (keys): {list(rows[57].keys())[:10]}...")
                # Print first few values from row 57
                for k in list(rows[57].keys())[:10]:
                    logging.info(f"  Column {k}: {rows[57][k]}")
            
            print(f"\nDataframe has {len(df)} rows", flush=True)
            print(f"Dataframe columns: {df.columns.tolist()}", flush=True)
            
            # Check if trade_status column has values
            if 'trade_status' in df.columns:
                print(f"\nTrade status sample values: {df['trade_status'].head(10).tolist()}", flush=True)
                print(f"Trade status unique: {df['trade_status'].unique()}", flush=True)

            # Clean and convert
            def clean_trade_type(label):
                """Strip the ticker symbol from 'SLV ROCT CALL' → 'ROCT CALL'"""
                parts = str(label).split()
                return " ".join(parts[1:]) if len(parts) > 1 else str(label)

            df["trade_date"] = pd.to_datetime(df["trade_date"], errors="coerce")
            df["expiration_date"] = pd.to_datetime(df["expiration_date"], errors="coerce")
            
            # Extract ticker and trade_type from trade_type_raw (format: "TICKER ROCT PUT")
            def extract_ticker(row):
                trade_type_raw = row.get('trade_type_raw')
                
                if pd.notna(trade_type_raw):
                    val = str(trade_type_raw).strip()
                    parts = val.split()
                    if len(parts) >= 2:
                        return parts[0]  # First word is ticker
                    elif len(parts) == 1:
                        return parts[0]
                
                return 'UNKNOWN'
            
            def extract_trade_type(row):
                trade_type_raw = row.get('trade_type_raw')
                
                if pd.notna(trade_type_raw):
                    val = str(trade_type_raw).strip()
                    parts = val.split()
                    if len(parts) >= 2:
                        return ' '.join(parts[1:])  # Everything after first word is trade type
                    elif len(parts) == 1:
                        return 'ROCT PUT'
                
                return 'ROCT PUT'
            
            # Apply both extractions
            df["ticker"] = df.apply(extract_ticker, axis=1)
            df["trade_type"] = df.apply(extract_trade_type, axis=1)
            
            # Print extracted trade types for debugging
            print("Extracted trade types from Excel:", df["trade_type"].unique(), flush=True)
            
            # Debug: Check if trade_status column exists and what values it has
            if 'trade_status' in df.columns:
                print("Trade status values in dataframe:", df["trade_status"].unique(), flush=True)
                print(f"Sample trade_status values: {df['trade_status'].head(10).tolist()}", flush=True)
            else:
                print("WARNING: trade_status column NOT found in dataframe!", flush=True)

            for n in ["current_price", "strike_price", "credit_debit", "num_of_contracts"]:
                df[n] = pd.to_numeric(df[n], errors="coerce")

            df = df.dropna(subset=["trade_date", "ticker"], how="any")

            # Import all trades
            df_to_insert = df

            # Insert into database
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Reset trades and cost_basis tables before importing
            cursor.execute('DELETE FROM cost_basis')
            cursor.execute('DELETE FROM trades')
            conn.commit()
            print("Reset trades and cost_basis tables before import", flush=True)
            
            # Check for duplicates against existing trades (will be empty after reset)
            try:
                existing = pd.read_sql("SELECT * FROM trades", conn)
                # Get ticker names for comparison
                existing_tickers = pd.read_sql("SELECT * FROM tickers", conn)
                if not existing_tickers.empty:
                    existing = existing.merge(existing_tickers[['id', 'ticker']], left_on='ticker_id', right_on='id', suffixes=('', '_ticker'))
                    existing['ticker'] = existing['ticker']
            except Exception:
                existing = pd.DataFrame()
            
            # Only import trades that don't already exist
            # Compare based on key fields
            if not existing.empty and not df_to_insert.empty:
                # Convert dates for comparison
                df_to_insert['trade_date_str'] = df_to_insert['trade_date'].dt.strftime('%Y-%m-%d')
                df_to_insert['expiration_date_str'] = df_to_insert['expiration_date'].dt.strftime('%Y-%m-%d')
                
                # Create comparison columns
                df_to_insert['key'] = (df_to_insert['ticker'] + '|' + 
                                     df_to_insert['trade_date_str'] + '|' + 
                                     df_to_insert['expiration_date_str'] + '|' + 
                                     df_to_insert['trade_type'].astype(str) + '|' + 
                                     df_to_insert['num_of_contracts'].astype(str) + '|' + 
                                     df_to_insert['credit_debit'].astype(str))
                
                if 'ticker' in existing.columns:
                    existing['key'] = (existing['ticker'].astype(str) + '|' + 
                                     existing['trade_date'].astype(str) + '|' + 
                                     existing['expiration_date'].astype(str) + '|' + 
                                     existing['trade_type'].astype(str) + '|' + 
                                     existing['num_of_contracts'].astype(str) + '|' + 
                                     existing['credit_debit'].astype(str))
                    
                    # Filter out duplicates
                    df_to_insert = df_to_insert[~df_to_insert['key'].isin(existing['key'])]
                
                # Drop helper columns
                df_to_insert = df_to_insert.drop(columns=['key', 'trade_date_str', 'expiration_date_str'], errors='ignore')
            
            # Store count before insertion loop
            final_count_before_insert = len(df_to_insert)
            imported_count = 0
            errors = []
            
            for idx, row in df_to_insert.iterrows():
                try:
                    # Get ticker safely
                    ticker = str(row.get('ticker', '')).strip()
                    if not ticker:
                        errors.append(f"Row {idx}: Missing ticker")
                        continue
                        
                    trade_date = row['trade_date'].strftime('%Y-%m-%d')
                    expiration_date = row['expiration_date'].strftime('%Y-%m-%d')
                    trade_type = str(row['trade_type']).strip()
                    
                    # Debug: Print trade_type being imported
                    print(f"Importing trade with trade_type: '{trade_type}' (ticker: {ticker})", flush=True)
                    
                    # Validate trade_type against trade_types table
                    cursor.execute("SELECT type_name FROM trade_types WHERE type_name = ?", (trade_type,))
                    valid_type = cursor.fetchone()
                    if not valid_type:
                        # Check if there's a similar valid type (e.g., underscores vs spaces)
                        cursor.execute("SELECT type_name FROM trade_types")
                        valid_types = [row['type_name'] for row in cursor.fetchall()]
                        error_msg = f"Row {idx} ({ticker}): Invalid trade_type '{trade_type}'. Valid types are: {', '.join(valid_types)}"
                        errors.append(error_msg)
                        print(f"Import Error: {error_msg}", flush=True)
                        continue
                    
                    num_of_contracts = int(row['num_of_contracts']) if pd.notna(row['num_of_contracts']) else 0
                    credit_debit = float(row['credit_debit']) if pd.notna(row['credit_debit']) else 0
                    strike_price = float(row['strike_price']) if pd.notna(row['strike_price']) else 0
                    current_price = float(row['current_price']) if pd.notna(row['current_price']) else 0
                    
                    # Read trade_status from row 64 (required, no default)
                    # Normalize to lowercase for case-insensitive matching
                    if 'trade_status' in row and pd.notna(row['trade_status']):
                        status_val = str(row['trade_status']).strip().lower().strip()  # Double strip to remove any whitespace
                        
                        # Debug: print the raw status value
                        print(f"Importing trade_status: raw='{row['trade_status']}', normalized='{status_val}' (ticker: {ticker})", flush=True)
                        
                        # Normalize common variations to standard values
                        # Excel dropdown order: open, expired, closed, roll, assigned
                        status_normalize = {
                            # Text values (handle all case variations)
                            'open': 'open',
                            'closed': 'closed',
                            'assigned': 'assigned',
                            'expired': 'expired',
                            'roll': 'roll',
                            'rolling': 'roll',
                            # Uppercase variants
                            'OPEN': 'open',
                            'CLOSED': 'closed',
                            'ASSIGNED': 'assigned',
                            'EXPIRED': 'expired',
                            'ROLL': 'roll',
                            # Excel dropdown numeric indices (0-indexed)
                            '0': 'open',      # First option
                            '1': 'expired',   # Second option
                            '2': 'closed',    # Third option
                            '3': 'roll',      # Fourth option
                            '4': 'assigned',  # Fifth option
                            # Excel status codes (mapped based on actual data)
                            '43': 'open',      # Less common, mapped to open
                            '79': 'expired',   # Most common - expired trades
                            '90': 'closed',    # Closed trades
                            '108': 'assigned', # Assigned trades (first 2 in your file)
                            '109': 'roll',     # Roll trades (next 6 in your file)
                        }
                        trade_status = status_normalize.get(status_val, 'open')
                        print(f"  Mapped to: '{trade_status}'", flush=True)
                    else:
                        # No status provided - skip this trade or use open as last resort
                        print(f"  WARNING: No trade_status in row for {ticker}, using 'open'", flush=True)
                        trade_status = 'open'
                    
                    # Get or create ticker (case-insensitive)
                    cursor.execute("SELECT id FROM tickers WHERE UPPER(ticker) = UPPER(?)", (ticker,))
                    ticker_row = cursor.fetchone()
                    if ticker_row:
                        ticker_id = ticker_row['id']
                    else:
                        # Insert ticker with company_name (use ticker as default, store as uppercase)
                        cursor.execute("INSERT INTO tickers (ticker, company_name) VALUES (?, ?)", (ticker.upper(), ticker.upper()))
                        ticker_id = cursor.lastrowid
                    
                    # Calculate days to expiration
                    trade_date_obj = datetime.strptime(trade_date, '%Y-%m-%d').date()
                    expiration = datetime.strptime(expiration_date, '%Y-%m-%d').date()
                    days_to_expiration = (expiration - trade_date_obj).days
                    
                    # Calculate total_premium
                    total_premium = credit_debit * num_of_contracts
                    
                    # Insert trade
                    cursor.execute('''
                        INSERT INTO trades 
                        (account_id, ticker_id, trade_date, expiration_date, num_of_contracts, 
                         credit_debit, total_premium, days_to_expiration, current_price, 
                         strike_price, trade_status, trade_type, price_per_share, total_amount)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (9, ticker_id, trade_date, expiration_date, num_of_contracts,
                          credit_debit, total_premium, days_to_expiration, current_price,
                          strike_price, trade_status, trade_type, current_price, total_premium))
                    
                    trade_id = cursor.lastrowid
                    
                    # Create cost basis entry for options trades
                    create_options_cost_basis_entry(cursor, 9, ticker_id, trade_id, trade_date, trade_type, 
                                                    num_of_contracts, credit_debit, strike_price, expiration_date)
                    
                    imported_count += 1
                    
                except Exception as e:
                    ticker_name = str(row.get('ticker', 'Unknown')).strip()
                    error_msg = f"Row {idx} ({ticker_name}): {str(e)}"
                    errors.append(error_msg)
                    print(f"Import Error: {error_msg}", flush=True)  # Print to console
            
            conn.commit()
            conn.close()
            
            skipped_count = final_count_before_insert - imported_count
            
            return jsonify({
                'success': True,
                'imported': imported_count,
                'skipped': skipped_count,
                'errors': errors
            })
            
        finally:
            # Clean up temporary file
            import os
            os.unlink(excel_path)
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5005)
