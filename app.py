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
import math
from decimal import Decimal, ROUND_HALF_UP
# Import migrations with fallback if not available
try:
    from migrations.migrate import run_migrations
except ImportError:
    # Fallback if migrations module is not available
    def run_migrations():
        logging.warning("Migrations module not available, skipping migrations")
        pass

# Import db_helper with fallback if not available
try:
    from db_helper import init_db_helper, get_db_helper
    _db_helper_available = True
except ImportError as e:
    # Fallback if db_helper module is not available
    logging.error(f"db_helper module not available: {e}")
    logging.error("Please ensure db_helper.py is in the same directory as app.py")
    _db_helper_available = False
    
    # Create a minimal fallback that will fail gracefully when used
    class DummyDBHelper:
        def __init__(self):
            self.database_path = None
        
        def get_raw_connection(self):
            raise RuntimeError("db_helper module not available. Please pull latest changes from git.")
        
        def get_commission_rate(self, *args, **kwargs):
            return 0.0  # Return default commission rate
        
        def get_accounts(self):
            return []
        
        def get_trades_filtered(self, *args, **kwargs):
            return []
        
        def get_trade(self, *args, **kwargs):
            return None
        
        def create_or_get_ticker(self, *args, **kwargs):
            raise RuntimeError("db_helper module not available. Please pull latest changes from git.")
        
        def execute_query(self, *args, **kwargs):
            return []
    
    _dummy_db_helper = DummyDBHelper()
    
    def init_db_helper(database_path):
        logging.warning("db_helper not available - using dummy helper. App may not work correctly.")
        _dummy_db_helper.database_path = database_path
    
    def get_db_helper():
        if not _db_helper_available:
            logging.warning("db_helper not available - returning dummy helper. Please pull latest changes from git.")
        return _dummy_db_helper

def round_standard(value, decimals=2):
    """Round to nearest value, always rounding 0.5 up (standard rounding)"""
    if value is None:
        return None
    # Create a dynamic quantize string based on the number of decimals
    quantize_str = '1.' + '0' * decimals
    return float(Decimal(str(value)).quantize(Decimal(quantize_str), rounding=ROUND_HALF_UP))

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

# Initialize database helper
init_db_helper(DATABASE)

# Run migrations on app startup (runs once when app starts)
_migrations_run = False
def ensure_migrations():
    """Ensure database migrations have been run - with timeout protection"""
    global _migrations_run
    if not _migrations_run:
        try:
            # Try to run migrations, but don't let them block for too long
            # On PythonAnywhere, migrations should be quick or run manually
            run_migrations()
            _migrations_run = True
            logging.info("Migrations completed successfully")
        except Exception as e:
            logging.warning(f"Migration error: {e}")
            logging.info("Falling back to init_db() for initial setup...")
            try:
                init_db()
                _migrations_run = True
            except Exception as init_error:
                # Even init_db can fail - just log and continue
                logging.error(f"init_db() also failed: {init_error}")
                logging.warning("App will continue without database initialization")
                _migrations_run = True  # Mark as run to prevent retrying

# Run migrations on first request (non-blocking to prevent 504 errors)
@app.before_request
def run_migrations_on_startup():
    """Run database migrations before first request - non-blocking"""
    global _migrations_run
    if not _migrations_run:
        try:
            # Run migrations but don't let them block the request
            # If they take too long or fail, just continue without them
            ensure_migrations()
        except Exception as e:
            # If migrations fail or timeout, log but don't block the request
            logging.warning(f"Migration skipped due to error: {e}")
            logging.info("App will continue without migrations - they can be run manually")
            _migrations_run = True  # Mark as run to prevent retrying on every request

def get_db_connection():
    """
    Get database connection (backward compatibility)
    
    Note: Prefer using get_db_helper() for new code
    """
    return get_db_helper().get_raw_connection()

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
            t.date_trade_open,
            t.expiration_date,
            t.num_of_contracts,
            t.credit_debit,
            t.total_premium,
            t.days_to_expiration,
            t.current_price,
            t.strike_price,
            t.trade_status,
            t.trade_type,
            t.commission_per_share,
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
            is_default BOOLEAN DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Add is_default column if it doesn't exist
    try:
        cursor.execute('ALTER TABLE accounts ADD COLUMN is_default BOOLEAN DEFAULT 0')
    except sqlite3.OperationalError:
        pass  # Column already exists
    
    # Insert default accounts if they don't exist
    cursor.execute('''
        INSERT OR IGNORE INTO accounts (account_name, account_type, is_default) 
        VALUES ('Rule One', 'INVESTMENT', 1)
    ''')
    
    # Ensure at least one account is set as default
    cursor.execute('SELECT COUNT(*) as count FROM accounts WHERE is_default = 1')
    default_count = cursor.fetchone()['count']
    if default_count == 0:
        # Set the first account (or Rule One if it exists) as default
        cursor.execute('SELECT id FROM accounts ORDER BY id LIMIT 1')
        first_account = cursor.fetchone()
        if first_account:
            cursor.execute('UPDATE accounts SET is_default = 1 WHERE id = ?', (first_account['id'],))
    
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
            ticker TEXT NOT NULL,
            date_trade_open TEXT NOT NULL,
            date_trade_closed TEXT DEFAULT NULL,
            expiration_date TEXT NOT NULL,
            num_of_contracts INTEGER NOT NULL,
            num_of_shares INTEGER DEFAULT NULL,
            credit_debit REAL NOT NULL,
            total_premium REAL NOT NULL,
            days_to_expiration INTEGER NOT NULL,
            current_price REAL NOT NULL,
            strike_price NUMERIC(12,2) NOT NULL,
            trade_status TEXT DEFAULT 'open',
            trade_type TEXT NOT NULL,
            commission_per_share REAL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            price_per_share REAL DEFAULT 0,
            total_amount REAL DEFAULT 0,
            net_credit_per_share NUMERIC(12,5) DEFAULT 0,
            risk_capital_per_share REAL DEFAULT 0,
            margin_percent REAL DEFAULT 100.0,
            ARORC NUMERIC(10,4) DEFAULT NULL,
            trade_type_id INTEGER,
            trade_parent_id INTEGER,
            FOREIGN KEY (ticker_id) REFERENCES tickers(id),
            FOREIGN KEY (account_id) REFERENCES accounts(id),
            FOREIGN KEY (trade_type_id) REFERENCES trade_types(id),
            FOREIGN KEY (trade_parent_id) REFERENCES trades(id)
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
            transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'ASSIGNMENT', 'SELL PUT', 'SELL CALL', 'Dividend')),
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
                    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'PREMIUM_CREDIT', 'PREMIUM_DEBIT', 'ASSIGNMENT', 'SELL PUT', 'SELL CALL', 'Dividend')),
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
    
    # Cleanup: Remove any leftover trades_new table from incomplete migrations
    # This should not happen if migrations run properly, but we clean up just in case
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades_new'")
    if cursor.fetchone():
        print("⚠ Warning: Found leftover trades_new table from incomplete migration. Cleaning up...")
        try:
            # Check if trades table exists and has data
            cursor.execute("SELECT COUNT(*) as count FROM trades")
            trades_count = cursor.fetchone()['count']
            
            # Check if trades_new has data
            cursor.execute("SELECT COUNT(*) as count FROM trades_new")
            trades_new_count = cursor.fetchone()['count']
            
            if trades_count == 0 and trades_new_count > 0:
                # trades is empty but trades_new has data - complete the migration
                print("Completing incomplete migration: trades is empty, trades_new has data")
                cursor.execute('DROP VIEW IF EXISTS v_trade_summary')
                cursor.execute('DROP VIEW IF EXISTS v_cost_basis_summary')
                cursor.execute('DROP VIEW IF EXISTS v_cash_flow_summary')
                cursor.execute('DROP TABLE trades')
                cursor.execute('ALTER TABLE trades_new RENAME TO trades')
                create_views(cursor)
                conn.commit()
                print("✓ Completed migration: renamed trades_new to trades")
            elif trades_count > 0 and trades_new_count > 0:
                # Both tables have data - this is a problem, keep trades and drop trades_new
                print("⚠ Both trades and trades_new have data. Keeping trades, dropping trades_new")
                cursor.execute('DROP TABLE trades_new')
                conn.commit()
                print("✓ Cleaned up trades_new table")
            else:
                # trades_new is empty or both are empty - just drop trades_new
                cursor.execute('DROP TABLE trades_new')
                conn.commit()
                print("✓ Cleaned up empty trades_new table")
        except Exception as e:
            print(f"⚠ Error cleaning up trades_new: {e}")
            # Don't fail the entire init if cleanup fails
            pass
    
    # Note: Schema migrations (status->trade_status, premium->credit_debit, commission_paid->commission_per_share)
    # are now handled by the migration system (migrations/migrate.py) and should not be done here.
    # The migration system runs automatically on app startup.

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
        'CREATE INDEX IF NOT EXISTS idx_trades_date_trade_open ON trades(date_trade_open)',
        'CREATE INDEX IF NOT EXISTS idx_trades_account_status ON trades(account_id, trade_status)',
        'CREATE INDEX IF NOT EXISTS idx_trades_account_date ON trades(account_id, date_trade_open)',
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
        # Using new database helper
        db = get_db_helper()
        accounts = db.get_accounts()
        return jsonify(accounts)
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

@app.route('/api/accounts/<int:account_id>', methods=['PUT'])
def update_account(account_id):
    try:
        data = request.get_json()
        account_name = data.get('account_name')
        account_type = data.get('account_type')
        starting_balance = data.get('starting_balance')
        is_default = data.get('is_default')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if account exists
        cursor.execute('SELECT id FROM accounts WHERE id = ?', (account_id,))
        account = cursor.fetchone()
        if not account:
            conn.close()
            return jsonify({'error': 'Account not found'}), 404
        
        # If setting this account as default, unset all other defaults
        if is_default:
            cursor.execute('UPDATE accounts SET is_default = 0 WHERE id != ?', (account_id,))
        
        # Update the account
        if is_default is not None:
            cursor.execute('''
                UPDATE accounts 
                SET account_name = ?, account_type = ?, starting_balance = ?, is_default = ?
                WHERE id = ?
            ''', (account_name, account_type, starting_balance, 1 if is_default else 0, account_id))
        else:
            cursor.execute('''
                UPDATE accounts 
                SET account_name = ?, account_type = ?, starting_balance = ?
                WHERE id = ?
            ''', (account_name, account_type, starting_balance, account_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

@app.route('/api/accounts/<int:account_id>/set-default', methods=['PUT'])
def set_default_account(account_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if account exists
        cursor.execute('SELECT id FROM accounts WHERE id = ?', (account_id,))
        account = cursor.fetchone()
        if not account:
            conn.close()
            return jsonify({'error': 'Account not found'}), 404
        
        # Unset all other defaults
        cursor.execute('UPDATE accounts SET is_default = 0')
        
        # Set this account as default
        cursor.execute('UPDATE accounts SET is_default = 1 WHERE id = ?', (account_id,))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

@app.route('/api/accounts/<int:account_id>', methods=['DELETE'])
def delete_account(account_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if account exists
        cursor.execute('SELECT id FROM accounts WHERE id = ?', (account_id,))
        account = cursor.fetchone()
        if not account:
            conn.close()
            return jsonify({'error': 'Account not found'}), 404
        
        # Check if account is referenced in trades
        cursor.execute('SELECT COUNT(*) as count FROM trades WHERE account_id = ?', (account_id,))
        trades_count = cursor.fetchone()['count']
        
        # Check if account is referenced in cost_basis
        cursor.execute('SELECT COUNT(*) as count FROM cost_basis WHERE account_id = ?', (account_id,))
        cost_basis_count = cursor.fetchone()['count']
        
        # Check if account is referenced in cash_flows
        cursor.execute('SELECT COUNT(*) as count FROM cash_flows WHERE account_id = ?', (account_id,))
        cash_flows_count = cursor.fetchone()['count']
        
        # Check if account is referenced in commissions
        cursor.execute('SELECT COUNT(*) as count FROM commissions WHERE account_id = ?', (account_id,))
        commissions_count = cursor.fetchone()['count']
        
        total_references = trades_count + cost_basis_count + cash_flows_count + commissions_count
        
        if total_references > 0:
            conn.close()
            return jsonify({
                'error': f'Cannot delete account. It is referenced in {trades_count} trade(s), {cost_basis_count} cost basis entry(ies), {cash_flows_count} cash flow(s), and {commissions_count} commission(s).'
            }), 400
        
        # Delete the account
        cursor.execute('DELETE FROM accounts WHERE id = ?', (account_id,))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

@app.route('/api/trade-types', methods=['GET'])
def get_trade_types():
    try:
        # Using new database helper
        db = get_db_helper()
        types = db.execute_query('SELECT * FROM trade_types ORDER BY category, type_name')
        return jsonify(types)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/refresh-metrics-cache', methods=['POST'])
def refresh_metrics_cache():
    """Refresh metrics cache - can be called nightly or on-demand"""
    try:
        account_id = request.json.get('account_id') if request.is_json else request.args.get('account_id', type=int)
        db = get_db_helper()
        db.refresh_trade_statistics_cache(account_id=account_id)
        return jsonify({'success': True, 'message': 'Metrics cache refreshed'})
    except Exception as e:
        print(f'Error refreshing metrics cache: {e}')
        return jsonify({'error': str(e)}), 500

@app.route('/api/bankroll-summary', methods=['GET'])
def get_bankroll_summary():
    try:
        # Get date filters, account filter, and status filter
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        account_id = request.args.get('account_id', type=int)  # None if not provided (show all accounts)
        status_filter = request.args.get('status_filter')  # 'open', 'completed', etc.
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get starting bankroll from accounts table
        if account_id:
            # Filter by specific account
            cursor.execute('''
                SELECT COALESCE(SUM(starting_balance), 0) as total
                FROM accounts
                WHERE id = ?
            ''', (account_id,))
        else:
            # Sum all accounts
            cursor.execute('''
                SELECT COALESCE(SUM(starting_balance), 0) as total
                FROM accounts
            ''')
        starting_bankroll = cursor.fetchone()['total']
        
        # Build query for premiums based on date filters and account
        query = '''
            SELECT COALESCE(SUM(CASE 
                WHEN trade_type = 'SELL' THEN credit_debit 
                ELSE -credit_debit 
            END), 0) as total_premiums
            FROM trades
            WHERE trade_status != 'roll'
        '''
        query_params = []
        if account_id:
            query += ' AND account_id = ?'
            query_params.append(account_id)
        
        if start_date:
            query += ' AND date_trade_open >= ?'
            query_params.append(start_date)
        if end_date:
            query += ' AND date_trade_open <= ?'
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
        base_where = 'trade_status != \'roll\' AND trade_type NOT IN (\'BTO\', \'STC\') AND (trade_type LIKE \'%ROCT PUT\' OR trade_type LIKE \'%ROCT CALL\' OR trade_type LIKE \'ROCT%\' OR trade_type LIKE \'BTO CALL\' OR trade_type LIKE \'STC CALL\')'
        if account_id:
            base_where += ' AND account_id = ?'
        
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
        query_params = []
        if account_id:
            query_params.append(account_id)
        
        if start_date:
            query += ' AND date_trade_open >= ?'
            query_params.append(start_date)
        if end_date:
            query += ' AND date_trade_open <= ?'
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
        breakdown_params = []
        if account_id:
            breakdown_params.append(account_id)
        
        if start_date:
            breakdown_query += ' AND date_trade_open >= ?'
            breakdown_params.append(start_date)
        if end_date:
            breakdown_query += ' AND date_trade_open <= ?'
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
        account_id = request.args.get('account_id')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # If account_id is provided and not empty, filter by account
        # Otherwise, return all commissions for all accounts
        if account_id and account_id != '' and account_id != 'all':
            cursor.execute('''
                SELECT c.*, a.account_name
                FROM commissions c
                LEFT JOIN accounts a ON c.account_id = a.id
                WHERE c.account_id = ?
                ORDER BY a.account_name, c.effective_date DESC
            ''', (account_id,))
        else:
            cursor.execute('''
                SELECT c.*, a.account_name
                FROM commissions c
                LEFT JOIN accounts a ON c.account_id = a.id
                ORDER BY a.account_name, c.effective_date DESC
            ''')
        
        commissions = cursor.fetchall()
        conn.close()
        
        return jsonify([dict(c) for c in commissions])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/commission-rate', methods=['GET'])
def get_commission_rate():
    """Get commission rate for a specific account and date"""
    try:
        account_id = request.args.get('account_id')
        date_trade_open = request.args.get('date_trade_open')
        
        if not account_id or not date_trade_open:
            return jsonify({'error': 'account_id and date_trade_open are required'}), 400
        
        account_id = int(account_id)
        db = get_db_helper()
        commission_rate = db.get_commission_rate(account_id, date_trade_open)
        
        return jsonify({'commission_rate': commission_rate})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def update_trades_for_commission(account_id, effective_date, commission_rate):
    """
    Update all trades where date_trade_open >= effective_date for the given account.
    For each trade, determines the correct commission rate to use (the one with the latest
    effective_date <= date_trade_open), then recalculates commission_per_share, net_credit_per_share,
    risk_capital_per_share, margin_capital, and ARORC for affected trades.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Find all trades that need to be updated (date_trade_open >= effective_date)
        cursor.execute('''
            SELECT id, credit_debit, strike_price, trade_type, num_of_contracts,
                   days_to_expiration, margin_percent, date_trade_open
            FROM trades
            WHERE account_id = ? AND date_trade_open >= ?
        ''', (account_id, effective_date))
        
        trades_to_update = cursor.fetchall()
        updated_count = 0
        
        for trade in trades_to_update:
            trade_id = trade['id']
            credit_debit = trade['credit_debit']
            strike_price = trade['strike_price']
            trade_type = trade['trade_type']
            num_of_contracts = trade['num_of_contracts']
            days_to_expiration = trade['days_to_expiration']
            # sqlite3.Row doesn't have .get(), use dictionary-style access with None check
            margin_percent = trade['margin_percent'] if trade['margin_percent'] is not None else 100.0
            date_trade_open = trade['date_trade_open']
            
            # Get the correct commission rate for this trade (the one with the latest effective_date <= date_trade_open)
            cursor.execute('''
                SELECT commission_rate
                FROM commissions
                WHERE account_id = ? AND effective_date <= ?
                ORDER BY effective_date DESC
                LIMIT 1
            ''', (account_id, date_trade_open))
            
            commission_row = cursor.fetchone()
            if commission_row:
                # Use the commission rate that applies to this trade
                trade_commission_rate = commission_row['commission_rate']
            else:
                # No commission found, use 0.0 as default
                trade_commission_rate = 0.0
            
            # Recalculate net_credit_per_share (rounded to 5 decimal places for storage, displayed as 2 decimals)
            net_credit_per_share = round_standard((credit_debit - trade_commission_rate), 5)
            
            # Recalculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades (rounded to nearest hundredth, always rounding 0.5 up)
            risk_capital_per_share = None
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                risk_capital_per_share = round_standard((strike_price - net_credit_per_share), 2)
            
            # Recalculate margin_capital
            # Use unrounded risk_capital_per_share for margin_capital calculation
            margin_capital = None
            if trade_type not in ['BTO', 'STC'] and strike_price > 0:
                if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                    # Use unrounded risk_capital_per_share for margin_capital calculation
                    risk_capital_unrounded = strike_price - net_credit_per_share
                    margin_capital = num_of_contracts * 100 * risk_capital_unrounded
                else:
                    margin_capital = (strike_price - net_credit_per_share) * num_of_contracts * 100
            
            # Calculate ARORC for ROCT PUT and RULE ONE PUT trades
            # margin_percent is stored as a percentage (100 = 100%), so divide by 100 to get decimal multiplier
            # Use unrounded risk_capital_per_share for ARORC calculation
            arorc = None
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                # Calculate unrounded risk_capital_per_share for ARORC calculation
                risk_capital_unrounded = strike_price - net_credit_per_share
                if risk_capital_unrounded > 0 and days_to_expiration > 0 and margin_percent > 0:
                    # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
                    denominator = risk_capital_unrounded * (margin_percent / 100.0)
                    if denominator > 0:
                        # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
                        arorc_decimal = (365.0 / days_to_expiration) * (net_credit_per_share / denominator)
                        arorc = round_standard(arorc_decimal * 100.0, 1)
            
            # Update the trade
            cursor.execute('''
                UPDATE trades 
                SET commission_per_share = ?,
                    net_credit_per_share = ?,
                    risk_capital_per_share = ?,
                    margin_capital = ?,
                    ARORC = ?
                WHERE id = ?
            ''', (trade_commission_rate, net_credit_per_share, risk_capital_per_share, margin_capital, arorc, trade_id))
            updated_count += 1
        
        conn.commit()
        return updated_count
    finally:
        conn.close()

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
        
        # Update all trades where date_trade_open >= effective_date
        updated_count = update_trades_for_commission(account_id, effective_date, commission_rate)
        print(f'Updated {updated_count} trades for new commission rate')
        
        return jsonify({'success': True, 'trades_updated': updated_count})
    except Exception as e:
        import traceback
        print(f'Error creating commission: {e}')
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

@app.route('/api/commissions/<int:commission_id>', methods=['PUT'])
def update_commission(commission_id):
    try:
        data = request.get_json()
        commission_rate = float(data.get('commission_rate'))
        effective_date = data.get('effective_date')
        notes = data.get('notes', '')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get the commission record to get account_id
        cursor.execute('SELECT account_id FROM commissions WHERE id = ?', (commission_id,))
        commission = cursor.fetchone()
        if not commission:
            conn.close()
            return jsonify({'error': 'Commission not found'}), 404
        
        account_id = commission['account_id']
        
        # Update the commission record
        cursor.execute('''
            UPDATE commissions 
            SET commission_rate = ?, effective_date = ?, notes = ?
            WHERE id = ?
        ''', (commission_rate, effective_date, notes, commission_id))
        conn.commit()
        conn.close()
        
        # Update all trades where date_trade_open >= effective_date
        updated_count = update_trades_for_commission(account_id, effective_date, commission_rate)
        print(f'Updated {updated_count} trades for updated commission rate')
        
        return jsonify({'success': True, 'trades_updated': updated_count})
    except Exception as e:
        import traceback
        print(f'Error updating commission: {e}')
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

@app.route('/api/commissions/<int:commission_id>', methods=['DELETE'])
def delete_commission(commission_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get the commission record before deleting it (need account_id and effective_date)
        cursor.execute('SELECT account_id, effective_date FROM commissions WHERE id = ?', (commission_id,))
        commission = cursor.fetchone()
        
        if not commission:
            conn.close()
            return jsonify({'error': 'Commission not found'}), 404
        
        account_id = commission['account_id']
        effective_date = commission['effective_date']
        
        # Delete the commission record
        cursor.execute('DELETE FROM commissions WHERE id = ?', (commission_id,))
        conn.commit()
        conn.close()
        
        # Update all trades where date_trade_open >= effective_date for this account
        # This will recalculate commission_per_share, net_credit_per_share, risk_capital_per_share,
        # margin_capital, and ARORC using the next available commission rate (or 0.0 if none)
        updated_count = update_trades_for_commission(account_id, effective_date, None)
        print(f'Updated {updated_count} trades after deleting commission rate')
        
        return jsonify({'success': True, 'trades_updated': updated_count})
    except Exception as e:
        import traceback
        print(f'Error deleting commission: {e}')
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

@app.route('/api/backfill-commissions', methods=['POST'])
def backfill_commissions():
    """
    Backfill all trades with the correct commission rates based on their account_id and date_trade_open.
    This updates all trades that have commission_per_share = 0 or need to be updated.
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all trades
        cursor.execute('''
            SELECT id, account_id, date_trade_open, credit_debit, strike_price, trade_type, 
                   num_of_contracts, days_to_expiration, margin_percent
            FROM trades
            ORDER BY account_id, date_trade_open
        ''')
        
        all_trades = cursor.fetchall()
        updated_count = 0
        
        for trade in all_trades:
            trade_id = trade['id']
            account_id = trade['account_id']
            date_trade_open = trade['date_trade_open']
            credit_debit = trade['credit_debit']
            strike_price = trade['strike_price']
            trade_type = trade['trade_type']
            num_of_contracts = trade['num_of_contracts']
            days_to_expiration = trade['days_to_expiration']
            margin_percent = trade['margin_percent'] if trade['margin_percent'] is not None else 100.0
            
            # Get the correct commission rate for this trade (the one with the latest effective_date <= date_trade_open)
            cursor.execute('''
                SELECT commission_rate
                FROM commissions
                WHERE account_id = ? AND effective_date <= ?
                ORDER BY effective_date DESC
                LIMIT 1
            ''', (account_id, date_trade_open))
            
            commission_row = cursor.fetchone()
            if commission_row:
                # Use the commission rate that applies to this trade
                trade_commission_rate = commission_row['commission_rate']
            else:
                # No commission found, use 0.0 as default
                trade_commission_rate = 0.0
            
            # Recalculate net_credit_per_share (rounded to 5 decimal places for storage, displayed as 2 decimals)
            net_credit_per_share = round_standard((credit_debit - trade_commission_rate), 5)
            
            # Recalculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades (rounded to nearest hundredth, always rounding 0.5 up)
            risk_capital_per_share = None
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                risk_capital_per_share = round_standard((strike_price - net_credit_per_share), 2)
            
            # Recalculate margin_capital
            # Use unrounded risk_capital_per_share for margin_capital calculation
            margin_capital = None
            if trade_type not in ['BTO', 'STC'] and strike_price > 0:
                if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                    # Use unrounded risk_capital_per_share for margin_capital calculation
                    risk_capital_unrounded = strike_price - net_credit_per_share
                    margin_capital = num_of_contracts * 100 * risk_capital_unrounded
                else:
                    margin_capital = (strike_price - net_credit_per_share) * num_of_contracts * 100
            
            # Calculate ARORC for ROCT PUT and RULE ONE PUT trades
            # margin_percent is stored as a percentage (100 = 100%), so divide by 100 to get decimal multiplier
            # Use unrounded risk_capital_per_share for ARORC calculation
            arorc = None
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                # Calculate unrounded risk_capital_per_share for ARORC calculation
                risk_capital_unrounded = strike_price - net_credit_per_share
                if risk_capital_unrounded > 0 and days_to_expiration > 0 and margin_percent > 0:
                    # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
                    denominator = risk_capital_unrounded * (margin_percent / 100.0)
                    if denominator > 0:
                        # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
                        arorc_decimal = (365.0 / days_to_expiration) * (net_credit_per_share / denominator)
                        arorc = round_standard(arorc_decimal * 100.0, 1)
            
            # Update the trade
            cursor.execute('''
                UPDATE trades 
                SET commission_per_share = ?,
                    net_credit_per_share = ?,
                    risk_capital_per_share = ?,
                    margin_capital = ?,
                    ARORC = ?
                WHERE id = ?
            ''', (trade_commission_rate, net_credit_per_share, risk_capital_per_share, margin_capital, arorc, trade_id))
            updated_count += 1
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'trades_updated': updated_count})
    except Exception as e:
        import traceback
        print(f'Error backfilling commissions: {e}')
        print(traceback.format_exc())
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
        # Get account_id - handle both string and int conversion
        account_id_arg = request.args.get('account_id')
        account_id = None
        if account_id_arg:
            try:
                account_id = int(account_id_arg)
            except (ValueError, TypeError):
                account_id = None
        
        print(f'[DEBUG] Trades query - account_id_arg: {account_id_arg}, account_id: {account_id}')
        
        ticker = request.args.get('ticker', '')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        # Using new database helper
        db = get_db_helper()
        trades = db.get_trades_filtered(
            account_id=account_id,
            ticker=ticker,
            start_date=start_date,
            end_date=end_date
        )
        
        print(f'[DEBUG] Trades query returned {len(trades)} trades')
        if trades:
            sample_trade = trades[0]
            print(f'[DEBUG] First trade - account_id: {sample_trade.get("account_id")}, account_name: {sample_trade.get("account_name")}, ticker: {sample_trade.get("ticker")}')
        
        # Add computed fields for backward compatibility and cumulative net credit
        trades_list = []
        # Create a map of trade_id to trade for quick lookup
        trade_map = {trade['id']: trade for trade in trades}
        
        def calculate_cumulative_net_credit(trade_id):
            """Calculate cumulative net credit for a trade by summing all ancestors"""
            if trade_id not in trade_map:
                return 0
            
            trade = trade_map[trade_id]
            trade_parent_id = trade.get('trade_parent_id')
            
            # Calculate net credit total for this trade
            num_of_contracts = trade.get('num_of_contracts', 1)
            net_credit_per_share = trade.get('net_credit_per_share', 0)
            net_credit_total = net_credit_per_share * num_of_contracts * 100 if trade.get('trade_type') not in ['BTO', 'STC'] else net_credit_per_share * num_of_contracts
            
            # If this trade has a parent, add parent's cumulative net credit
            if trade_parent_id:
                parent_cumulative = calculate_cumulative_net_credit(trade_parent_id)
                return parent_cumulative + net_credit_total
            
            # Root trade: return its own net credit total
            return net_credit_total
        
        for trade_dict in trades:
            trade_dict['shares'] = trade_dict['num_of_contracts'] * 100 if trade_dict['trade_type'] not in ['BTO', 'STC'] else trade_dict['num_of_contracts']
            # Calculate cumulative net credit total
            trade_dict['cumulative_net_credit_total'] = calculate_cumulative_net_credit(trade_dict['id'])
            trades_list.append(trade_dict)
        
        return jsonify(trades_list)
    except Exception as e:
        print(f'Error fetching trades: {e}')
        return jsonify({'error': 'Failed to fetch trades'}), 500

@app.route('/api/trades/<int:trade_id>', methods=['GET'])
def get_trade(trade_id):
    try:
        # Using new database helper
        db = get_db_helper()
        trade_dict = db.get_trade(trade_id)
        
        if not trade_dict:
            return jsonify({'error': 'Trade not found'}), 404
        
        # Add computed fields for backward compatibility
        trade_dict['shares'] = trade_dict['num_of_contracts'] * 100 if trade_dict['trade_type'] not in ['BTO', 'STC'] else trade_dict['num_of_contracts']
        
        return jsonify(trade_dict)
    except Exception as e:
        print(f'Error fetching trade {trade_id}: {e}')
        return jsonify({'error': 'Failed to fetch trade'}), 500

@app.route('/api/trades', methods=['POST'])
def add_trade():
    conn = None  # Initialize conn outside try block so it's accessible in except
    try:
        data = request.get_json()
        print(f'[DEBUG] add_trade - Received data: {data}', flush=True)
        
        ticker = data['ticker'].upper()
        date_trade_open = data['tradeDate']
        expiration_date = data['expirationDate']
        num_of_contracts = int(data['num_of_contracts'])
        premium = float(data['premium'])
        current_price = float(data['currentPrice'])
        strike_price = round_standard(float(data.get('strikePrice', 0)), 2)
        trade_type = data.get('tradeType', 'ROCT PUT')
        account_id = data.get('accountId', 9)  # Default to Rule One
        
        # Ensure account_id is an integer
        account_id = int(account_id)
        
        print(f'[DEBUG] add_trade - Parsed values: ticker={ticker}, date_trade_open={date_trade_open}, expiration_date={expiration_date}, num_of_contracts={num_of_contracts}, premium={premium}, current_price={current_price}, strike_price={strike_price}, trade_type={trade_type}, account_id={account_id} (type: {type(account_id)})', flush=True)
        
        # Store the base trade type for lookup (before modifying)
        base_trade_type = trade_type
        
        # Modify trade type to include ticker for options trades
        if trade_type in ['ROCT PUT', 'ROCT CALL', 'ROP', 'ROC']:
            trade_type = f"{ticker} {trade_type}"
        
        # Get or create symbol (using new helper)
        db = get_db_helper()
        ticker_id = db.create_or_get_ticker(ticker, ticker)
        
        # Get trade_type_id from trade_types table
        # Insert trade (using raw connection for complex transaction)
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (base_trade_type,))
        trade_type_row = cursor.fetchone()
        trade_type_id = trade_type_row['id'] if trade_type_row else None
        
        # Validate that trade_type_id exists
        if trade_type_id is None:
            conn.close()
            return jsonify({'error': f'Invalid trade type: "{base_trade_type}" does not exist in trade_types table'}), 400
        
        # Calculate days to expiration
        date_trade_open_obj = datetime.strptime(date_trade_open, '%Y-%m-%d').date()
        expiration = datetime.strptime(expiration_date, '%Y-%m-%d').date()
        days_to_expiration = (expiration - date_trade_open_obj).days
        
        # Calculate total premium based on trade type
        # Also calculate num_of_shares
        if trade_type in ['BTO', 'STC']:
            total_premium = premium * num_of_contracts
            price_per_share = premium
            total_amount = total_premium
            # For stock trades, num_of_shares should be provided in data, default to num_of_contracts if not provided
            num_of_shares = data.get('num_of_shares', num_of_contracts)
        else:
            total_premium = premium * num_of_contracts * 100
            price_per_share = 0
            total_amount = 0
            # For options trades, calculate num_of_shares = num_of_contracts * 100
            num_of_shares = num_of_contracts * 100
        
        # Get commission rate in effect at trade date (using new helper)
        print(f'[DEBUG] Before get_commission_rate: account_id={account_id} (type: {type(account_id)}), date_trade_open={date_trade_open} (type: {type(date_trade_open)})', flush=True)
        commission = db.get_commission_rate(account_id, date_trade_open)
        print(f'[DEBUG] Commission calculated for account_id={account_id}, date_trade_open={date_trade_open}: {commission}', flush=True)
        
        # Calculate net_credit_per_share = credit_debit - commission_per_share (rounded to 5 decimal places for storage, displayed as 2 decimals)
        net_credit_per_share = round_standard((premium - commission), 5)
        
        # Calculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades (rounded to nearest hundredth, always rounding 0.5 up)
        # risk_capital_per_share = strike_price - net_credit_per_share (only for ROCT PUT and RULE ONE PUT)
        risk_capital_per_share = None
        if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
            risk_capital_per_share = round_standard((strike_price - net_credit_per_share), 2)
        
        # Calculate margin_capital for options trades
        # Use unrounded risk_capital_per_share for margin_capital calculation
        margin_capital = None
        if trade_type not in ['BTO', 'STC'] and strike_price > 0:
            # For ROCT PUT and RULE ONE PUT trades, use unrounded risk_capital_per_share
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                # Use unrounded risk_capital_per_share for margin_capital calculation
                risk_capital_unrounded = strike_price - net_credit_per_share
                margin_capital = num_of_contracts * 100 * risk_capital_unrounded
            else:
                # For other options trades, use the standard calculation
                margin_capital = (strike_price - net_credit_per_share) * num_of_contracts * 100
        
        # Set default margin_percent to 100%
        margin_percent = 100.0
        
        # Calculate ARORC for ROCT PUT and RULE ONE PUT trades
        # ARORC = (365 / days_to_expiration) * (net_credit_per_share / (risk_capital_per_share * (margin_percent / 100)))
        # margin_percent is stored as a percentage (100 = 100%), so divide by 100 to get decimal multiplier
        # Use unrounded risk_capital_per_share for ARORC calculation
        arorc = None
        if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
            # Calculate unrounded risk_capital_per_share for ARORC calculation
            risk_capital_unrounded = strike_price - net_credit_per_share
            if risk_capital_unrounded > 0 and days_to_expiration > 0 and margin_percent > 0:
                # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
                denominator = risk_capital_unrounded * (margin_percent / 100.0)
                if denominator > 0:
                    # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
                    arorc_decimal = (365.0 / days_to_expiration) * (net_credit_per_share / denominator)
                    arorc = round_standard(arorc_decimal * 100.0, 1)
        
        # Insert trade (using raw connection for complex transaction)
        cursor.execute('''
            INSERT INTO trades 
            (account_id, ticker_id, ticker, date_trade_open, expiration_date, num_of_contracts, num_of_shares, credit_debit, total_premium, 
             days_to_expiration, current_price, strike_price, trade_status, trade_type, 
             price_per_share, total_amount, commission_per_share, margin_capital, net_credit_per_share, risk_capital_per_share, margin_percent, ARORC, trade_type_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, ticker, date_trade_open, expiration_date, num_of_contracts, num_of_shares, premium, total_premium,
              days_to_expiration, current_price, strike_price, 'open', trade_type,
              price_per_share, total_amount, commission, margin_capital, net_credit_per_share, risk_capital_per_share, margin_percent, arorc, trade_type_id))
        
        trade_id = cursor.lastrowid
        print(f'[DEBUG] Trade created with trade_id={trade_id}, commission_per_share={commission}', flush=True)
        
        # Create cost basis entry for ALL trades
        print(f'[DEBUG] Creating cost_basis entry: base_trade_type={base_trade_type}, trade_type={trade_type}, account_id={account_id}', flush=True)
        try:
            if base_trade_type in ['BTO', 'STC']:
                print(f'[DEBUG] Creating cost_basis entry for BTO/STC trade', flush=True)
                create_cost_basis_entry(cursor, account_id, ticker_id, trade_id, date_trade_open, base_trade_type, num_of_contracts, premium, total_premium)
            else:
                # Create cost basis entry for options trades (ROCT PUT, ROCT CALL, etc.)
                print(f'[DEBUG] Creating cost_basis entry for options trade: account_id={account_id}, ticker_id={ticker_id}, trade_id={trade_id}', flush=True)
                create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, date_trade_open, trade_type, num_of_contracts, premium, strike_price, expiration_date)
                print(f'[DEBUG] Cost_basis entry created successfully for trade_id={trade_id}', flush=True)
        except Exception as cost_basis_error:
            import traceback
            error_detail = traceback.format_exc()
            print(f'[ERROR] Failed to create cost_basis entry: {cost_basis_error}', flush=True)
            print(f'[ERROR] Traceback: {error_detail}', flush=True)
            # Re-raise so the transaction is rolled back
            raise
        
        # Create cash flow entry for EVERY trade based on requires_contracts
        cash_flow_id = None
        
        # Check if this trade type requires contracts (use base_trade_type, not the full trade_type with ticker)
        cursor.execute('SELECT requires_contracts FROM trade_types WHERE type_name = ?', (base_trade_type,))
        trade_type_row = cursor.fetchone()
        requires_contracts = trade_type_row['requires_contracts'] if trade_type_row else 0
        print(f'[DEBUG] Trade type lookup: base_trade_type={base_trade_type}, requires_contracts={requires_contracts}', flush=True)
        
        if requires_contracts == 1:
            # Options trade: determine if PUT or CALL (use base_trade_type for checking)
            if 'PUT' in base_trade_type or 'ROP' in base_trade_type:
                transaction_type = 'SELL PUT'
            elif 'CALL' in base_trade_type or 'ROC' in base_trade_type:
                transaction_type = 'SELL CALL'
            else:
                # Default to PREMIUM_CREDIT if can't determine
                transaction_type = 'PREMIUM_CREDIT'
            cash_flow_amount = round(premium * num_of_contracts * 100, 2)
            print(f'[DEBUG] Creating cash_flow entry: account_id={account_id}, date_trade_open={date_trade_open}, transaction_type={transaction_type}, amount={cash_flow_amount}', flush=True)
            try:
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (account_id, date_trade_open, transaction_type, cash_flow_amount, 
                      f"{trade_type} premium received", trade_id, ticker_id))
                cash_flow_id = cursor.lastrowid
                print(f'[DEBUG] Cash_flow entry created with id={cash_flow_id}', flush=True)
            except Exception as cash_flow_error:
                import traceback
                error_detail = traceback.format_exc()
                print(f'[ERROR] Failed to create cash_flow entry: {cash_flow_error}', flush=True)
                print(f'[ERROR] Traceback: {error_detail}', flush=True)
                # Re-raise so the transaction is rolled back
                raise
        else:
            # For BTO/STC or other trade types that don't require contracts
            # These are stock trades, use PREMIUM_CREDIT or PREMIUM_DEBIT
            if trade_type == 'BTO':
                transaction_type = 'PREMIUM_DEBIT'  # Buying stock
            else:
                transaction_type = 'PREMIUM_CREDIT'  # Selling stock
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, date_trade_open, transaction_type, round(total_premium, 2), 
                  f"{trade_type} {num_of_contracts} shares", trade_id, ticker_id))
            cash_flow_id = cursor.lastrowid
        
        # Update cost_basis entry to link to cash_flow if cash flow was created
        if cash_flow_id:
            cursor.execute('''
                UPDATE cost_basis SET cash_flow_id = ? 
                WHERE trade_id = ? AND ticker_id = ? AND transaction_date = ? AND cash_flow_id IS NULL
            ''', (cash_flow_id, trade_id, ticker_id, date_trade_open))
            rows_updated = cursor.rowcount
            if rows_updated > 0:
                print(f'[DEBUG] Updated cost_basis entry to link cash_flow_id={cash_flow_id} for trade_id={trade_id} (rows updated: {rows_updated})', flush=True)
            else:
                print(f'[WARNING] UPDATE cost_basis to link cash_flow_id={cash_flow_id} for trade_id={trade_id} did not update any rows. Checking if cost_basis entry exists...', flush=True)
                # Check if cost_basis entry exists but already has a cash_flow_id
                cursor.execute('SELECT id, cash_flow_id FROM cost_basis WHERE trade_id = ? AND ticker_id = ? AND transaction_date = ?', (trade_id, ticker_id, date_trade_open))
                existing_entry = cursor.fetchone()
                if existing_entry:
                    print(f'[DEBUG] Found cost_basis entry id={existing_entry["id"]}, cash_flow_id={existing_entry["cash_flow_id"]}', flush=True)
                else:
                    print(f'[ERROR] No cost_basis entry found for trade_id={trade_id}, ticker_id={ticker_id}, transaction_date={date_trade_open}', flush=True)
        
        # Verify cost_basis entry was created
        cursor.execute('SELECT id FROM cost_basis WHERE trade_id = ?', (trade_id,))
        cost_basis_check = cursor.fetchone()
        if cost_basis_check:
            print(f'[DEBUG] Verified cost_basis entry exists: id={cost_basis_check["id"]}', flush=True)
        else:
            print(f'[ERROR] cost_basis entry NOT found for trade_id={trade_id}', flush=True)
        
        # Verify cash_flow entry was created
        if cash_flow_id:
            cursor.execute('SELECT id FROM cash_flows WHERE id = ?', (cash_flow_id,))
            cash_flow_check = cursor.fetchone()
            if cash_flow_check:
                print(f'[DEBUG] Verified cash_flow entry exists: id={cash_flow_check["id"]}', flush=True)
            else:
                print(f'[ERROR] cash_flow entry NOT found for cash_flow_id={cash_flow_id}', flush=True)
        
        conn.commit()
        print(f'[DEBUG] Transaction committed successfully', flush=True)
        conn.close()
        
        # Invalidate metrics cache for this account (cache will refresh on next read)
        db.invalidate_metrics_cache(account_id=account_id)
        
        print(f'[DEBUG] Trade creation completed successfully: trade_id={trade_id}, cost_basis created, cash_flow_id={cash_flow_id}', flush=True)
        return jsonify({'success': True, 'trade_id': trade_id})
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'[ERROR] Error adding trade: {e}', flush=True)
        print(f'[ERROR] Traceback: {error_detail}', flush=True)
        # Rollback transaction on error if connection exists
        try:
            if conn is not None:
                conn.rollback()
                conn.close()
                print(f'[DEBUG] Transaction rolled back due to error', flush=True)
        except Exception as rollback_error:
            print(f'[ERROR] Error during rollback: {rollback_error}', flush=True)
        return jsonify({'success': False, 'error': f'Failed to add trade: {str(e)}'}), 500

def create_cost_basis_entry(cursor, account_id, ticker_id, trade_id, date_trade_open, trade_type, num_of_contracts, price_per_share, total_amount):
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
    ''', (account_id, ticker_id, trade_id, None, date_trade_open, description, display_shares, price_per_share,
          total_amount, new_running_basis, new_running_shares, basis_per_share))

def create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, date_trade_open, trade_type, num_of_contracts, premium, strike_price, expiration_date):
    """Create cost basis entry for options trades (ROCT PUT, ROCT CALL, etc.)"""
    import sys
    print(f"create_options_cost_basis_entry: ticker_id={ticker_id}, account_id={account_id}, date_trade_open={date_trade_open}", file=sys.stderr)
    try:
        # Get ticker for description
        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
        ticker = cursor.fetchone()['ticker']
        
        # Format expiration date as DD-MMM-YY
        try:
            exp_date = datetime.strptime(expiration_date, '%Y-%m-%d')
            # Use %d which already zero-pads, but ensure it's uppercase
            expiration_formatted = exp_date.strftime('%d-%b-%y').upper()
            print(f"Formatted expiration date: {expiration_date} -> {expiration_formatted}", file=sys.stderr)
        except Exception as e:
            print(f"Error formatting expiration date {expiration_date}: {e}", file=sys.stderr)
            expiration_formatted = expiration_date  # Fallback
        
        # Create trade description based on trade type
        # Format strike_price and premium to 2 decimal places
        strike_str = f"{strike_price:.2f}" if strike_price else "0.0"
        premium_str = f"{premium:.2f}" if premium else "0.0"
        
        print(f"create_options_cost_basis_entry: strike_price={strike_price}, premium={premium}, num_of_contracts={num_of_contracts}", file=sys.stderr)
        
        if 'ROP' in trade_type or 'PUT' in trade_type:
            description = f"SELL -{num_of_contracts} {ticker} 100 {expiration_formatted} {strike_str} PUT @{premium_str}"
        elif 'ROC' in trade_type or 'CALL' in trade_type:
            description = f"SELL -{num_of_contracts} {ticker} 100 {expiration_formatted} {strike_str} CALL @{premium_str}"
        else:
            description = f"SELL -{num_of_contracts} {ticker} 100 {expiration_formatted} {strike_str} {trade_type} @{premium_str}"
        
        print(f"create_options_cost_basis_entry: description={description}", file=sys.stderr)
        
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
        ''', (account_id, ticker_id, trade_id, None, date_trade_open, description, shares, cost_per_share,
              total_amount, new_running_basis, new_running_shares, basis_per_share))
        
        cost_basis_id = cursor.lastrowid
        print(f"[DEBUG] Created cost basis entry for options trade {trade_id}: id={cost_basis_id}, description={description}", flush=True)
        print(f"[DEBUG] Cost basis entry details: account_id={account_id}, ticker_id={ticker_id}, trade_id={trade_id}, transaction_date={date_trade_open}, total_amount={total_amount}", flush=True)
        
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f"[ERROR] Error creating options cost basis entry: {e}", flush=True)
        print(f"[ERROR] Traceback: {error_detail}", flush=True)
        # Re-raise the exception so the calling function knows it failed
        raise

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
        
        # Get cost basis entries before deletion to know which ticker/account to recalculate
        cursor.execute('SELECT ticker_id, account_id FROM cost_basis WHERE trade_id = ? LIMIT 1', (trade_id,))
        cost_basis_entry = cursor.fetchone()
        
        # If no cost_basis entry, get ticker_id and account_id from the trade itself
        if not cost_basis_entry:
            trade_dict = dict(trade)
            ticker_id = trade_dict.get('ticker_id')
            account_id = trade_dict.get('account_id')
        else:
            ticker_id = cost_basis_entry['ticker_id']
            account_id = cost_basis_entry['account_id']
        
        # Delete associated cost basis entries
        cursor.execute('DELETE FROM cost_basis WHERE trade_id = ?', (trade_id,))
        
        # Delete associated cash flows
        cursor.execute('DELETE FROM cash_flows WHERE trade_id = ?', (trade_id,))
        
        # Delete the trade
        cursor.execute('DELETE FROM trades WHERE id = ?', (trade_id,))
        
        # Recalculate running totals for all remaining cost_basis entries for this ticker/account
        if ticker_id and account_id:
            
            # Get all remaining entries for this ticker/account ordered by transaction_date
            cursor.execute('''
                SELECT id, total_amount, shares, transaction_date, rowid
                FROM cost_basis 
                WHERE ticker_id = ? AND account_id = ?
                ORDER BY transaction_date ASC, rowid ASC
            ''', (ticker_id, account_id))
            all_entries = cursor.fetchall()
            
            # Recalculate running totals sequentially
            running_basis = 0
            running_shares = 0
            for entry in all_entries:
                entry_dict = dict(entry)
                running_basis += entry_dict['total_amount']
                running_shares += entry_dict['shares']
                basis_per_share = running_basis / running_shares if running_shares != 0 else running_basis
                
                cursor.execute('''
                    UPDATE cost_basis 
                    SET running_basis = ?, running_shares = ?, basis_per_share = ?
                    WHERE id = ?
                ''', (running_basis, running_shares, basis_per_share, entry_dict['id']))
        
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
        
        # Track if dates are being updated (needed for DTE recalculation)
        date_trade_open_updated = False
        expiration_date_updated = False
        new_date_trade_open = None
        new_expiration_date = None
        
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
            updates.append('ticker = ?')
            params.append(ticker)
        
        if 'tradeDate' in data:
            date_trade_open_updated = True
            new_date_trade_open = data['tradeDate']
            updates.append('date_trade_open = ?')
            params.append(new_date_trade_open)
        elif 'date_trade_open' in data:
            date_trade_open_updated = True
            new_date_trade_open = data['date_trade_open']
            updates.append('date_trade_open = ?')
            params.append(new_date_trade_open)
        
        if 'expirationDate' in data:
            expiration_date_updated = True
            new_expiration_date = data['expirationDate']
            updates.append('expiration_date = ?')
            params.append(new_expiration_date)
        elif 'expiration_date' in data:
            expiration_date_updated = True
            new_expiration_date = data['expiration_date']
            updates.append('expiration_date = ?')
            params.append(new_expiration_date)
        
        # Recalculate days_to_expiration if either date changed
        days_to_expiration_updated = False
        new_days_to_expiration = None
        if date_trade_open_updated or expiration_date_updated:
            # Use new dates if provided, otherwise use current trade dates
            date_trade_open_for_dte = new_date_trade_open if date_trade_open_updated else trade['date_trade_open']
            expiration_date_for_dte = new_expiration_date if expiration_date_updated else trade['expiration_date']
            
            # Calculate days to expiration
            date_trade_open_obj = datetime.strptime(date_trade_open_for_dte, '%Y-%m-%d').date()
            expiration = datetime.strptime(expiration_date_for_dte, '%Y-%m-%d').date()
            days_to_expiration = (expiration - date_trade_open_obj).days
            days_to_expiration_updated = True
            new_days_to_expiration = days_to_expiration
            
            updates.append('days_to_expiration = ?')
            params.append(days_to_expiration)
        
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
            # Recalculate margin_capital when num_of_contracts changes
            current_trade_type = data.get('tradeType') or trade['trade_type']
            current_strike = float(data.get('strikePrice') or trade['strike_price'])
            current_risk_capital = trade.get('risk_capital_per_share')
            if current_risk_capital is not None and ('ROCT PUT' in current_trade_type or 'RULE ONE PUT' in current_trade_type or ('PUT' in current_trade_type and ('ROCT' in current_trade_type or 'RULE ONE' in current_trade_type))):
                # For ROCT PUT and RULE ONE PUT trades, use risk_capital_per_share
                new_margin_capital = num_contracts * 100 * current_risk_capital
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
            elif current_trade_type not in ['BTO', 'STC'] and current_strike > 0:
                # For other options trades, use standard calculation
                current_commission = trade.get('commission_per_share', 0)
                current_net_credit = current_credit_debit - current_commission
                new_margin_capital = (current_strike - current_net_credit) * num_contracts * 100
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
        
        if 'premium' in data or 'creditDebit' in data:
            credit_debit = float(data.get('premium') or data.get('creditDebit'))
            updates.append('credit_debit = ?')
            params.append(credit_debit)
            # Recalculate total_premium when credit_debit changes
            current_num_contracts = trade['num_of_contracts']
            new_total_premium = credit_debit * current_num_contracts
            updates.append('total_premium = ?')
            params.append(new_total_premium)
            # Recalculate net_credit_per_share and risk_capital_per_share (net_credit rounded to 5 decimals, risk_capital to 2 decimals)
            current_commission = trade.get('commission_per_share', 0)
            new_net_credit = round_standard((credit_debit - current_commission), 5)
            updates.append('net_credit_per_share = ?')
            params.append(new_net_credit)
            # Recalculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades
            current_trade_type = data.get('tradeType') or trade['trade_type']
            current_strike = float(data.get('strikePrice') or trade['strike_price'])
            if 'ROCT PUT' in current_trade_type or 'RULE ONE PUT' in current_trade_type or ('PUT' in current_trade_type and ('ROCT' in current_trade_type or 'RULE ONE' in current_trade_type)):
                new_risk_capital = round_standard((current_strike - new_net_credit), 2)
                updates.append('risk_capital_per_share = ?')
                params.append(new_risk_capital)
                # Recalculate margin_capital for ROCT PUT and RULE ONE PUT trades
                # Use unrounded risk_capital_per_share for margin_capital calculation
                current_num_contracts = trade['num_of_contracts']
                risk_capital_unrounded = current_strike - new_net_credit
                new_margin_capital = current_num_contracts * 100 * risk_capital_unrounded
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
            else:
                updates.append('risk_capital_per_share = ?')
                params.append(None)
                # For other options trades, recalculate margin_capital using standard formula
                if current_trade_type not in ['BTO', 'STC'] and current_strike > 0:
                    current_num_contracts = trade['num_of_contracts']
                    new_margin_capital = (current_strike - new_net_credit) * current_num_contracts * 100
                    updates.append('margin_capital = ?')
                    params.append(new_margin_capital)
        
        if 'currentPrice' in data:
            updates.append('current_price = ?')
            params.append(float(data['currentPrice']))
        
        if 'strikePrice' in data:
            strike_price = round_standard(float(data['strikePrice']), 2)
            updates.append('strike_price = ?')
            params.append(strike_price)
            # Recalculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades when strike changes (rounded to nearest hundredth)
            current_trade_type = data.get('tradeType') or trade['trade_type']
            current_credit_debit = float(data.get('premium') or data.get('creditDebit') or trade['credit_debit'])
            current_commission = trade.get('commission_per_share', 0)
            current_net_credit = round_standard((current_credit_debit - current_commission), 5)
            if 'ROCT PUT' in current_trade_type or 'RULE ONE PUT' in current_trade_type or ('PUT' in current_trade_type and ('ROCT' in current_trade_type or 'RULE ONE' in current_trade_type)):
                new_risk_capital = round_standard((strike_price - current_net_credit), 2)
                updates.append('risk_capital_per_share = ?')
                params.append(new_risk_capital)
                # Recalculate margin_capital for ROCT PUT and RULE ONE PUT trades
                current_num_contracts = trade['num_of_contracts']
                new_margin_capital = current_num_contracts * 100 * new_risk_capital
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
            else:
                # For other options trades, recalculate margin_capital using standard formula
                if current_trade_type not in ['BTO', 'STC'] and strike_price > 0:
                    current_num_contracts = trade['num_of_contracts']
                    new_margin_capital = (strike_price - current_net_credit) * current_num_contracts * 100
                    updates.append('margin_capital = ?')
                    params.append(new_margin_capital)
        
        if 'tradeType' in data:
            new_trade_type = data['tradeType']
            
            # Extract base trade type (before ticker prefix for options)
            base_trade_type = new_trade_type
            if 'ROCT PUT' in new_trade_type or 'ROCT CALL' in new_trade_type:
                # Extract base type (e.g., "ROCT PUT" from "AAPL ROCT PUT")
                if 'ROCT PUT' in new_trade_type:
                    base_trade_type = 'ROCT PUT'
                elif 'ROCT CALL' in new_trade_type:
                    base_trade_type = 'ROCT CALL'
            
            # Validate that trade_type_id exists for the new trade type
            cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (base_trade_type,))
            trade_type_row = cursor.fetchone()
            new_trade_type_id = trade_type_row['id'] if trade_type_row else None
            
            if new_trade_type_id is None:
                conn.close()
                return jsonify({'error': f'Invalid trade type: "{base_trade_type}" does not exist in trade_types table'}), 400
            
            # Update both trade_type and trade_type_id
            updates.append('trade_type = ?')
            params.append(new_trade_type)
            updates.append('trade_type_id = ?')
            params.append(new_trade_type_id)
            
            # Recalculate risk_capital_per_share based on new trade type (rounded to nearest hundredth)
            current_credit_debit = float(data.get('premium') or data.get('creditDebit') or trade['credit_debit'])
            current_commission = trade.get('commission_per_share', 0)
            current_net_credit = round_standard((current_credit_debit - current_commission), 5)
            current_strike = float(data.get('strikePrice') or trade['strike_price'])
            if 'ROCT PUT' in new_trade_type or 'RULE ONE PUT' in new_trade_type or ('PUT' in new_trade_type and ('ROCT' in new_trade_type or 'RULE ONE' in new_trade_type)):
                new_risk_capital = round_standard((current_strike - current_net_credit), 2)
                updates.append('risk_capital_per_share = ?')
                params.append(new_risk_capital)
                # Recalculate margin_capital for ROCT PUT and RULE ONE PUT trades
                current_num_contracts = trade['num_of_contracts']
                new_margin_capital = current_num_contracts * 100 * new_risk_capital
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
            else:
                updates.append('risk_capital_per_share = ?')
                params.append(None)
                # For other options trades, recalculate margin_capital using standard formula
                if new_trade_type not in ['BTO', 'STC'] and current_strike > 0:
                    current_num_contracts = trade['num_of_contracts']
                    new_margin_capital = (current_strike - current_net_credit) * current_num_contracts * 100
                    updates.append('margin_capital = ?')
                    params.append(new_margin_capital)
                else:
                    updates.append('margin_capital = ?')
                    params.append(None)
        
        # Recalculate net_credit_per_share and risk_capital_per_share if commission_per_share changes
        if 'commission_per_share' in data or 'commissionPerShare' in data:
            commission = float(data.get('commission_per_share') or data.get('commissionPerShare'))
            updates.append('commission_per_share = ?')
            params.append(commission)
            # Recalculate net_credit_per_share (rounded to 5 decimal places for storage, displayed as 2 decimals)
            current_credit_debit = float(data.get('premium') or data.get('creditDebit') or trade['credit_debit'])
            new_net_credit = round_standard((current_credit_debit - commission), 5)
            updates.append('net_credit_per_share = ?')
            params.append(new_net_credit)
            # Recalculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades (rounded to nearest hundredth)
            current_trade_type = data.get('tradeType') or trade['trade_type']
            current_strike = float(data.get('strikePrice') or trade['strike_price'])
            if 'ROCT PUT' in current_trade_type or 'RULE ONE PUT' in current_trade_type or ('PUT' in current_trade_type and ('ROCT' in current_trade_type or 'RULE ONE' in current_trade_type)):
                new_risk_capital = round_standard((current_strike - new_net_credit), 2)
                updates.append('risk_capital_per_share = ?')
                params.append(new_risk_capital)
                # Recalculate margin_capital for ROCT PUT and RULE ONE PUT trades
                # Use unrounded risk_capital_per_share for margin_capital calculation
                current_num_contracts = trade['num_of_contracts']
                risk_capital_unrounded = current_strike - new_net_credit
                new_margin_capital = current_num_contracts * 100 * risk_capital_unrounded
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
            else:
                # For other options trades, recalculate margin_capital using standard formula
                if current_trade_type not in ['BTO', 'STC'] and current_strike > 0:
                    current_num_contracts = trade['num_of_contracts']
                    new_margin_capital = (current_strike - new_net_credit) * current_num_contracts * 100
                    updates.append('margin_capital = ?')
                    params.append(new_margin_capital)
        
        # Recalculate ARORC for ROCT PUT and RULE ONE PUT trades
        # ARORC = (365 / days_to_expiration) * (net_credit_per_share / (risk_capital_per_share * margin_percent))
        # Get current values for ARORC calculation
        current_trade_type = data.get('tradeType') or trade['trade_type']
        current_days_to_expiration = new_days_to_expiration if days_to_expiration_updated else trade['days_to_expiration']
        current_net_credit = None
        current_risk_capital = None
        current_margin_percent = trade.get('margin_percent', 100.0)
        
        # Determine current net_credit_per_share (rounded to 5 decimal places for storage, displayed as 2 decimals)
        if 'premium' in data or 'creditDebit' in data:
            current_credit_debit = float(data.get('premium') or data.get('creditDebit'))
            current_commission = trade.get('commission_per_share', 0)
            current_net_credit = round_standard((current_credit_debit - current_commission), 5)
        elif 'commission_per_share' in data or 'commissionPerShare' in data:
            current_credit_debit = float(data.get('premium') or data.get('creditDebit') or trade['credit_debit'])
            commission = float(data.get('commission_per_share') or data.get('commissionPerShare'))
            current_net_credit = round_standard((current_credit_debit - commission), 5)
        else:
            current_net_credit = trade.get('net_credit_per_share', 0)
        
        # Determine current risk_capital_per_share (rounded to nearest hundredth) for storage
        # But use unrounded value for ARORC calculation
        current_risk_capital_for_storage = None
        current_risk_capital_unrounded = None
        if 'ROCT PUT' in current_trade_type or 'RULE ONE PUT' in current_trade_type or ('PUT' in current_trade_type and ('ROCT' in current_trade_type or 'RULE ONE' in current_trade_type)):
            # Check if risk_capital_per_share was updated
            if 'strikePrice' in data or 'premium' in data or 'creditDebit' in data or 'commission_per_share' in data or 'commissionPerShare' in data or 'tradeType' in data:
                current_strike = float(data.get('strikePrice') or trade['strike_price'])
                current_risk_capital_for_storage = round_standard((current_strike - current_net_credit), 2)
                # Use unrounded value for ARORC calculation
                current_risk_capital_unrounded = current_strike - current_net_credit
            else:
                current_risk_capital_for_storage = trade.get('risk_capital_per_share')
                # Calculate unrounded value for ARORC calculation
                current_strike = float(data.get('strikePrice') or trade['strike_price'])
                current_risk_capital_unrounded = current_strike - current_net_credit
        
        # Calculate ARORC if all required values are available
        # margin_percent is stored as a percentage (100 = 100%), so divide by 100 to get decimal multiplier
        # Use unrounded risk_capital_per_share for ARORC calculation
        new_arorc = None
        if 'ROCT PUT' in current_trade_type or 'RULE ONE PUT' in current_trade_type or ('PUT' in current_trade_type and ('ROCT' in current_trade_type or 'RULE ONE' in current_trade_type)):
            if current_risk_capital_unrounded is not None and current_risk_capital_unrounded > 0 and current_days_to_expiration > 0 and current_margin_percent > 0 and current_net_credit is not None:
                # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
                denominator = current_risk_capital_unrounded * (current_margin_percent / 100.0)
                if denominator > 0:
                    # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
                    arorc_decimal = (365.0 / current_days_to_expiration) * (current_net_credit / denominator)
                    new_arorc = round_standard(arorc_decimal * 100.0, 1)
        
        # Add ARORC update if calculated
        if new_arorc is not None or ('ROCT PUT' not in current_trade_type and 'RULE ONE PUT' not in current_trade_type and not ('PUT' in current_trade_type and ('ROCT' in current_trade_type or 'RULE ONE' in current_trade_type))):
            updates.append('ARORC = ?')
            params.append(new_arorc)
        
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
        
        if not new_status:
            return jsonify({'error': 'Status is required'}), 400
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get current trade
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade = cursor.fetchone()
        
        if not trade:
            conn.close()
            return jsonify({'error': 'Trade not found'}), 404
        
        # Convert trade to dict for easier access
        trade_dict = dict(trade) if hasattr(trade, 'keys') and not isinstance(trade, dict) else trade
        print(f'[DEBUG] update_trade_status - trade_id: {trade_id}, new_status: {new_status}, trade_dict keys: {list(trade_dict.keys()) if isinstance(trade_dict, dict) else "N/A"}')
        print(f'[DEBUG] update_trade_status - ticker_id: {trade_dict.get("ticker_id")}, expiration_date: {trade_dict.get("expiration_date")}, num_of_contracts: {trade_dict.get("num_of_contracts")}, strike_price: {trade_dict.get("strike_price")}')
        
        old_status = trade_dict.get('trade_status') or 'open'  # Default to 'open' if None
        
        # Update status and closing_debit based on new status
        # If status is not 'roll' or 'closed', set closing_debit to 0.00
        new_status_lower = new_status.lower() if new_status else ''
        if new_status_lower not in ['roll', 'closed']:
            cursor.execute('UPDATE trades SET trade_status = ?, closing_debit = 0.00, total_debit = 0.00 WHERE id = ?', (new_status, trade_id))
        else:
            cursor.execute('UPDATE trades SET trade_status = ? WHERE id = ?', (new_status, trade_id))
        
        # Record status change (only if status actually changed)
        if old_status != new_status:
            try:
                cursor.execute('''
                    INSERT INTO trade_status_history (trade_id, old_status, new_status)
                    VALUES (?, ?, ?)
                ''', (trade_id, old_status, new_status))
            except Exception as e:
                # If trade_status_history table doesn't exist or has issues, log but don't fail
                print(f'Warning: Could not insert into trade_status_history: {e}')
                import traceback
                print(f'Traceback: {traceback.format_exc()}')
        
        # Handle assigned trades - create cost basis entry and cash flow entry
        if new_status == 'assigned' and old_status != 'assigned':
            # Create assigned cost basis entry (same pattern as ROCT CALL)
            create_assigned_cost_basis_entry(cursor, trade)
            
            # Create cash flow entry for the assignment
            # Convert Row to dict if needed
            account_id = trade_dict.get('account_id', 9)
            ticker_id = trade_dict['ticker_id']
            date_trade_open = trade_dict['date_trade_open']
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
            
            # Use expiration_date + 2 days as transaction_date for assigned trades
            expiration_date = trade_dict.get('expiration_date', date_trade_open)
            from datetime import datetime, timedelta
            try:
                exp_date_obj = datetime.strptime(expiration_date, '%Y-%m-%d')
                assignment_transaction_date = (exp_date_obj + timedelta(days=2)).strftime('%Y-%m-%d')
            except:
                assignment_transaction_date = expiration_date  # Fallback to expiration_date if parsing fails
            
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, assignment_transaction_date, 'ASSIGNMENT', round(total_amount, 2), 
                  description, trade_id, ticker_id))
            cash_flow_id = cursor.lastrowid
            
            # Link the cost_basis entry to this cash flow
            # Use expiration_date as transaction_date for cost_basis (cost_basis uses expiration_date, cash_flow uses expiration_date + 2)
            assigned_date_trade_open = trade_dict.get('expiration_date', date_trade_open)
            cursor.execute('''
                UPDATE cost_basis SET cash_flow_id = ? 
                WHERE trade_id = ? AND account_id = ? AND ticker_id = ? AND transaction_date = ?
                AND description LIKE 'ASSIGNED%' AND cash_flow_id IS NULL
            ''', (cash_flow_id, trade_id, account_id, ticker_id, assigned_date_trade_open))
        
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
        
        # Handle rolling - create a new trade entry
        if new_status == 'roll' and old_status == 'open':
            print(f'[DEBUG] Creating roll trade for trade_id: {trade_id}')
            # Convert Row to dict if needed (already done above)
            # trade_dict is already created at the beginning of the function
            account_id = trade_dict.get('account_id', 9)
            ticker_id = trade_dict.get('ticker_id')
            if not ticker_id:
                error_msg = f"Trade {trade_id} is missing ticker_id for roll"
                print(f'Error: {error_msg}')
                conn.rollback()
                conn.close()
                return jsonify({'error': error_msg}), 400
            trade_type = trade_dict.get('trade_type', '')
            print(f'[DEBUG] Roll trade - account_id: {account_id}, ticker_id: {ticker_id}, trade_type: {trade_type}')
            
            # Get ticker symbol for trade_type formatting
            cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
            ticker_row = cursor.fetchone()
            if not ticker_row:
                error_msg = f"Ticker not found for ticker_id {ticker_id} (trade_id: {trade_id})"
                print(f'Error: {error_msg}')
                conn.rollback()
                conn.close()
                return jsonify({'error': error_msg}), 400
            ticker = ticker_row['ticker']
            print(f'[DEBUG] Roll trade - ticker: {ticker}')
            
            # Get base trade type (remove ticker prefix if present)
            base_trade_type = trade_type
            if ticker and trade_type.startswith(ticker + ' '):
                base_trade_type = trade_type[len(ticker) + 1:]
            print(f'[DEBUG] Roll trade - base_trade_type: {base_trade_type}')
            
            # Get trade_type_id
            cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (base_trade_type,))
            trade_type_row = cursor.fetchone()
            trade_type_id = trade_type_row['id'] if trade_type_row else None
            
            # If trade_type_id is not found, try to get it from the original trade
            if trade_type_id is None:
                trade_type_id = trade_dict.get('trade_type_id')
                print(f'Warning: trade_type_id not found for base_trade_type "{base_trade_type}", using original trade_type_id: {trade_type_id}')
            
            # Get current date for the new trade and to set date_trade_rolled on parent
            from datetime import datetime
            current_date = datetime.now().strftime('%Y-%m-%d')
            
            # Set date_trade_rolled on the original trade to current date
            cursor.execute('UPDATE trades SET date_trade_rolled = ? WHERE id = ?', (current_date, trade_id))
            
            # Recalculate existing child trades' DTE and ARORC when parent is rolled
            # Find all existing child trades
            cursor.execute('SELECT * FROM trades WHERE trade_parent_id = ?', (trade_id,))
            existing_child_trades = cursor.fetchall()
            for child_row in existing_child_trades:
                child_trade = safe_row_to_dict(child_row)
                child_trade_id = child_trade.get('id')
                child_date_trade_open = child_trade.get('date_trade_open')
                
                if child_date_trade_open:
                    from datetime import datetime
                    try:
                        date_trade_open_obj = datetime.strptime(child_date_trade_open, '%Y-%m-%d')
                        exp_date_obj = datetime.strptime(current_date, '%Y-%m-%d')  # Use parent's date_trade_rolled
                        days_to_exp = (exp_date_obj - date_trade_open_obj).days
                        
                        # Update child trade's DTE
                        cursor.execute('UPDATE trades SET days_to_expiration = ? WHERE id = ?', (days_to_exp, child_trade_id))
                        
                        # Recalculate child trade's ARORC if it's a ROCT PUT or RULE ONE PUT
                        child_trade_type = child_trade.get('trade_type', '')
                        if 'ROCT PUT' in child_trade_type or 'RULE ONE PUT' in child_trade_type or ('PUT' in child_trade_type and ('ROCT' in child_trade_type or 'RULE ONE' in child_trade_type)):
                            child_net_credit = child_trade.get('net_credit_per_share', 0)
                            child_strike = child_trade.get('strike_price', 0)
                            child_margin_percent = child_trade.get('margin_percent', 100.0)
                            
                            risk_capital_unrounded = child_strike - child_net_credit
                            if risk_capital_unrounded > 0 and days_to_exp > 0 and child_margin_percent > 0:
                                denominator = risk_capital_unrounded * (child_margin_percent / 100.0)
                                if denominator > 0:
                                    arorc_decimal = (365.0 / days_to_exp) * (child_net_credit / denominator)
                                    new_arorc = round_standard(arorc_decimal * 100.0, 1)
                                    cursor.execute('UPDATE trades SET ARORC = ? WHERE id = ?', (new_arorc, child_trade_id))
                    except Exception as e:
                        print(f'Error recalculating child trade {child_trade_id}: {e}')
                        pass  # If date parsing fails, skip recalculation
            
            # Get parent trade's original expiration date to save in child trade
            # Child trade's expiration_date should store parent's original expiration_date
            parent_expiration_date = trade_dict.get('expiration_date', current_date)
            
            # Format trade_type with ticker for options trades (same rules as ROCT CALL)
            # Apply ticker prefix to all trade types that should have it
            if base_trade_type in ['ROCT PUT', 'ROCT CALL', 'ROC', 'ROP', 'RULE ONE PUT', 'RULE ONE CALL']:
                formatted_trade_type = f"{ticker} {base_trade_type}"
            else:
                # For other trade types, preserve the original format (may already have ticker or may not need it)
                formatted_trade_type = trade_type
            print(f'[DEBUG] Roll trade - formatted_trade_type: {formatted_trade_type}')
            print(f'[DEBUG] Roll trade - parent_expiration_date: {parent_expiration_date}')
            
            # Get commission rate in effect at trade date (using same logic as add_trade)
            db = get_db_helper()
            print(f'[DEBUG] Roll trade - Before get_commission_rate: account_id={account_id} (type: {type(account_id)}), date_trade_open={current_date} (type: {type(current_date)})', flush=True)
            commission = db.get_commission_rate(account_id, current_date)
            print(f'[DEBUG] Roll trade - Commission calculated for account_id={account_id}, date_trade_open={current_date}: {commission}', flush=True)
            
            # Create a new trade entry with default values (same rules as ROCT CALL roll)
            # Use the same ticker, trade_type, and account
            # Set default values for editable fields
            # Set trade_parent_id to the original trade's ID
            # Include ticker column (added in migration 015)
            try:
                # Calculate num_of_shares for child trade
                child_num_of_contracts = trade_dict.get('num_of_contracts', 1)
                # For options trades, num_of_shares = num_of_contracts * 100
                # Check if it's an options trade (not BTO/STC)
                child_num_of_shares = None
                if base_trade_type not in ['BTO', 'STC']:
                    child_num_of_shares = child_num_of_contracts * 100
                
                cursor.execute('''
                    INSERT INTO trades 
                    (account_id, ticker_id, ticker, date_trade_open, expiration_date, num_of_contracts, num_of_shares,
                     credit_debit, total_premium, days_to_expiration, current_price, strike_price, trade_status, 
                     trade_type, commission_per_share, price_per_share, total_amount, margin_capital,
                     net_credit_per_share, risk_capital_per_share, margin_percent, ARORC, trade_type_id, trade_parent_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    account_id,
                    ticker_id,
                    ticker,        # Include ticker column (same as ROCT CALL roll)
                    current_date,  # Child's date_trade_open = current date (date when roll happened)
                    parent_expiration_date,  # Child's expiration_date = parent's original expiration_date (save for reference)
                    child_num_of_contracts,  # Use same num_of_contracts as parent trade
                    child_num_of_shares,  # num_of_shares = num_of_contracts * 100 for options trades
                    0.0,           # Default credit/debit (editable)
                    0.0,           # Default total_premium
                    0,             # Default DTE (will be recalculated using parent's date_trade_rolled)
                    0.0,           # Default current_price
                    0.0,           # Default strike (editable)
                    'open',        # New trade starts as 'open'
                    formatted_trade_type,    # Same trade_type (formatted with ticker)
                    commission,   # Commission rate in effect at trade date
                    0.0,           # Default price_per_share
                    0.0,           # Default total_amount
                    None,          # Default margin_capital (NULL)
                    0.0,           # Default net_credit_per_share (will be recalculated when credit_debit is set)
                    None,          # Default risk_capital_per_share (NULL)
                    100.0,         # Default margin percent
                    None,          # Default ARORC (NULL, will be recalculated using parent's date_trade_rolled)
                    trade_type_id,  # trade_type_id
                    trade_id  # trade_parent_id - set to the original trade's ID
                ))
                new_trade_id = cursor.lastrowid
                print(f'[DEBUG] Roll trade - new_trade_id created: {new_trade_id}')
            except Exception as e:
                import traceback
                error_msg = f"Error creating roll trade: {str(e)}"
                print(f'Error: {error_msg}')
                print(f'Traceback: {traceback.format_exc()}')
                conn.rollback()
                conn.close()
                return jsonify({'error': error_msg}), 500
            
            # Don't create diagonal cost basis entry here - it will be created when the new trade
            # is filled in with actual values (strike, credit, expiration_date) in update_trade_field
            # This ensures the diagonal entry has real values, not default 0.0 values
            
            # Return the new trade ID so frontend can update it
            conn.commit()
            print(f'[DEBUG] Roll trade - committed, new_trade_id: {new_trade_id}')
            conn.close()
            
            return jsonify({
                'success': True,
                'new_trade_id': new_trade_id,
                'message': 'New trade created for roll'
            })
        
        conn.commit()
        conn.close()
        
        # Invalidate metrics cache for this account
        db = get_db_helper()
        account_id = trade_dict.get('account_id')
        if account_id:
            db.invalidate_metrics_cache(account_id=account_id)
        
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        print(f'Error updating trade status: {e}')
        print(f'Traceback: {traceback.format_exc()}')
        if 'conn' in locals():
            try:
                conn.rollback()
                conn.close()
            except:
                pass
        return jsonify({'error': f'Failed to update trade status: {str(e)}'}), 500

@app.route('/api/trades/quick-add', methods=['POST'])
def quick_add_trade():
    """Create a new trade with default values for quick add functionality"""
    conn = None
    try:
        data = request.get_json()
        trade_type = data.get('tradeType')
        account_id = data.get('accountId', 9)  # Default to Rule One
        ticker = data.get('ticker', '').strip().upper()  # Optional, can be empty
        
        if not trade_type:
            return jsonify({'error': 'tradeType is required'}), 400
        
        # Validate trade type
        valid_quick_add_types = ['ROC', 'ROCT CALL', 'ROCT PUT', 'ROP']
        if trade_type not in valid_quick_add_types:
            return jsonify({'error': f'Invalid trade type for quick add: {trade_type}. Must be one of: {", ".join(valid_quick_add_types)}'}), 400
        
        # Ensure account_id is an integer
        account_id = int(account_id)
        
        # Get current date
        from datetime import datetime, timedelta
        current_date = datetime.now().strftime('%Y-%m-%d')
        
        # Calculate expiration date (10 days from today, or use today if ticker not provided)
        expiration_date = (datetime.now() + timedelta(days=10)).strftime('%Y-%m-%d')
        if not ticker:
            expiration_date = current_date  # Use current date if no ticker
        
        # Get or create ticker if provided
        db = get_db_helper()
        ticker_id = None
        if ticker:
            ticker_id = db.create_or_get_ticker(ticker, ticker)
        else:
            # If no ticker, we still need a ticker_id for the database
            # Use a placeholder or create a generic one - but actually, we should require ticker
            # For now, let's allow empty ticker and set ticker_id to NULL (but trades table requires ticker_id)
            # Actually, let's create a placeholder ticker or use a default
            # Check if there's a way to handle this - for now, let's require ticker
            # Actually, looking at the roll trade logic, it always has a ticker, so let's require it here too
            # But the user said ticker can be empty initially, so we need to handle it
            # Let's create a placeholder ticker "TBD" or similar
            ticker = 'TBD'
            ticker_id = db.create_or_get_ticker(ticker, ticker)
        
        # Get trade_type_id
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (trade_type,))
        trade_type_row = cursor.fetchone()
        trade_type_id = trade_type_row['id'] if trade_type_row else None
        
        if trade_type_id is None:
            conn.close()
            return jsonify({'error': f'Invalid trade type: "{trade_type}" does not exist in trade_types table'}), 400
        
        # Format trade_type with ticker for options trades
        base_trade_type = trade_type
        if trade_type in ['ROCT PUT', 'ROCT CALL', 'ROP', 'ROC']:
            formatted_trade_type = f"{ticker} {trade_type}"
        else:
            formatted_trade_type = trade_type
        
        # Get commission rate in effect at trade date
        print(f'[DEBUG] Quick add - Before get_commission_rate: account_id={account_id} (type: {type(account_id)}), date_trade_open={current_date} (type: {type(current_date)})', flush=True)
        commission = db.get_commission_rate(account_id, current_date)
        print(f'[DEBUG] Quick add - Commission calculated for account_id={account_id}, date_trade_open={current_date}: {commission}', flush=True)
        
        # Default values (same as roll trade creation)
        num_of_contracts = 1
        num_of_shares = num_of_contracts * 100  # For options trades
        
        # Insert trade with default values
        try:
            cursor.execute('''
                INSERT INTO trades 
                (account_id, ticker_id, ticker, date_trade_open, expiration_date, num_of_contracts, num_of_shares,
                 credit_debit, total_premium, days_to_expiration, current_price, strike_price, trade_status, 
                 trade_type, commission_per_share, price_per_share, total_amount, margin_capital,
                 net_credit_per_share, risk_capital_per_share, margin_percent, ARORC, trade_type_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                account_id,
                ticker_id,
                ticker,
                current_date,
                expiration_date,
                num_of_contracts,
                num_of_shares,
                0.0,           # Default credit/debit (editable)
                0.0,           # Default total_premium
                0,             # Default DTE (will be recalculated when dates are set)
                0.0,           # Default current_price
                0.0,           # Default strike (editable)
                'open',        # New trade starts as 'open'
                formatted_trade_type,
                commission,   # Commission rate in effect at trade date
                0.0,           # Default price_per_share
                0.0,           # Default total_amount
                None,          # Default margin_capital (NULL)
                0.0,           # Default net_credit_per_share (will be recalculated when credit_debit is set)
                None,          # Default risk_capital_per_share (NULL)
                100.0,         # Default margin percent
                None,          # Default ARORC (NULL, will be recalculated when dates/strikes are set)
                trade_type_id
            ))
            new_trade_id = cursor.lastrowid
            print(f'[DEBUG] Quick add - new_trade_id created: {new_trade_id}')
        except Exception as e:
            import traceback
            error_msg = f"Error creating quick add trade: {str(e)}"
            print(f'Error: {error_msg}')
            print(f'Traceback: {traceback.format_exc()}')
            conn.rollback()
            conn.close()
            return jsonify({'error': error_msg}), 500
        
        # Commit and return
        conn.commit()
        print(f'[DEBUG] Quick add - committed, new_trade_id: {new_trade_id}')
        conn.close()
        
        return jsonify({
            'success': True,
            'new_trade_id': new_trade_id,
            'message': 'New trade created via quick add'
        })
    except Exception as e:
        import traceback
        print(f'Error in quick_add_trade: {e}')
        print(f'Traceback: {traceback.format_exc()}')
        if conn:
            try:
                conn.rollback()
                conn.close()
            except:
                pass
        return jsonify({'error': f'Failed to create quick add trade: {str(e)}'}), 500

def create_roll_diagonal_cost_basis_entry(cursor, new_trade_id, original_trade_id, account_id, ticker_id, 
                                         date_trade_open, ticker, new_exp_date, original_exp_date,
                                         new_strike, original_strike, new_credit, original_trade_type, new_num_contracts):
    """Create cost basis entry for roll trades with diagonal format"""
    try:
        # Format dates as DD-MMM-YY
        from datetime import datetime
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
        
        # Insert cost basis entry
        cursor.execute('''
            INSERT INTO cost_basis 
            (account_id, ticker_id, trade_id, cash_flow_id, transaction_date, description, shares, cost_per_share, 
             total_amount, running_basis, running_shares, basis_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, new_trade_id, None, date_trade_open, description, shares, cost_per_share,
              total_amount, new_running_basis, new_running_shares, basis_per_share))
        
        print(f"Created roll diagonal cost basis entry for trade {new_trade_id}: {description}")
        
    except Exception as e:
        import traceback
        print(f"Error creating roll diagonal cost basis entry: {e}")
        print(f"Traceback: {traceback.format_exc()}")

def create_assigned_cost_basis_entry(cursor, trade):
    """Create cost basis entry for assigned trades"""
    print(f"Creating assigned cost basis entry for trade: {trade}")
    # Convert Row to dict for easier access
    trade_dict = dict(trade) if isinstance(trade, sqlite3.Row) else trade
    account_id = trade_dict.get('account_id', 9)  # Default to Rule One
    ticker_id = trade_dict.get('ticker_id')
    if not ticker_id:
        raise ValueError(f"ticker_id is required for assigned trades")
    trade_id = trade_dict.get('id')
    if not trade_id:
        raise ValueError(f"trade_id is required for assigned trades")
    date_trade_open = trade_dict.get('date_trade_open')
    trade_type = trade_dict.get('trade_type', '')
    num_of_contracts = trade_dict.get('num_of_contracts', 0)
    strike_price = trade_dict.get('strike_price', 0)
    
    # Validate required fields
    if not num_of_contracts or num_of_contracts == 0:
        raise ValueError(f"num_of_contracts must be greater than 0 for assigned trades (trade_id: {trade_id})")
    if not strike_price or strike_price == 0:
        raise ValueError(f"strike_price must be greater than 0 for assigned trades (trade_id: {trade_id})")
    
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
    # Use transaction_date to get the most recent entry chronologically
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
        raise ValueError(f"Ticker not found for ticker_id {ticker_id} (trade_id: {trade_id})")
    ticker = ticker_row['ticker']
    
    # Use expiration date as the transaction date for assigned trades
    expiration_date = trade_dict.get('expiration_date')
    if not expiration_date:
        print(f"Error: expiration_date is missing for trade {trade_id}")
        raise ValueError(f"expiration_date is required for assigned trades (trade_id: {trade_id})")
    
    assigned_date_trade_open = expiration_date
    
    # Format expiration date
    try:
        exp_date = datetime.strptime(expiration_date, '%Y-%m-%d').strftime('%d-%b-%y').upper()
    except (ValueError, TypeError) as e:
        print(f"Error parsing expiration_date '{expiration_date}' for trade {trade_id}: {e}")
        raise ValueError(f"Invalid expiration_date format for trade {trade_id}: {expiration_date}")
    
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
    ''', (account_id, ticker_id, trade_id, None, assigned_date_trade_open, description, shares, cost_per_share,
          total_amount, new_running_basis, new_running_shares, basis_per_share))

def safe_row_to_dict(row):
    """Safely convert SQLite Row object to dict, handling all edge cases"""
    if row is None:
        return {}
    if isinstance(row, dict):
        return row
    
    # SQLite Row objects can be converted using dict() constructor
    # This is the most reliable method and should work for all SQLite Row objects
    try:
        return dict(row)
    except Exception as e:
        # If conversion fails for any reason, log and return empty dict
        print(f'[WARNING] safe_row_to_dict failed to convert row type {type(row)}: {e}', flush=True)
        import traceback
        print(f'[WARNING] Traceback: {traceback.format_exc()}', flush=True)
        return {}

def get_effective_expiration_date(cursor, trade):
    """
    Get the effective expiration date for a trade.
    For child trades (trades with trade_parent_id), use parent's date_trade_rolled.
    Otherwise, use trade's own expiration_date.
    """
    trade_parent_id = trade.get('trade_parent_id')
    if trade_parent_id:
        # Get parent trade's date_trade_rolled
        cursor.execute('SELECT date_trade_rolled FROM trades WHERE id = ?', (trade_parent_id,))
        parent_row = cursor.fetchone()
        if parent_row:
            parent_dict = safe_row_to_dict(parent_row)
            parent_date_trade_rolled = parent_dict.get('date_trade_rolled')
            if parent_date_trade_rolled:
                return parent_date_trade_rolled
    
    # Use trade's own expiration_date
    return trade.get('expiration_date')

@app.route('/api/trades/<int:trade_id>/field', methods=['PUT'])
def update_trade_field(trade_id):
    try:
        data = request.get_json()
        field = data['field']
        value = data['value']
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Validate field name (use snake_case to match database schema)
        valid_fields = ['num_of_contracts', 'credit_debit', 'strike_price', 'trade_status', 'current_price', 'expiration_date', 'ticker', 'date_trade_open', 'account_id', 'closing_debit', 'total_debit', 'date_trade_rolled', 'notes']
        if field not in valid_fields:
            return jsonify({'error': 'Invalid field'}), 400
        
        # Get current trade to recalculate dependent fields
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade_row = cursor.fetchone()
        
        if not trade_row:
            return jsonify({'error': 'Trade not found'}), 404
        
        # Convert Row to dict for easier access
        trade = safe_row_to_dict(trade_row)
        
        # Get ticker for cost basis entry creation
        ticker_id = trade.get('ticker_id')
        if ticker_id:
            cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
            ticker_row = cursor.fetchone()
            if ticker_row:
                ticker_row_dict = safe_row_to_dict(ticker_row)
                ticker = ticker_row_dict.get('ticker', '')
            else:
                ticker = ''
        else:
            ticker = ''
        
        updates = []
        params = []
        
        # Convert value to appropriate type (field names already match database schema)
        db_field_name = field
        if field == 'num_of_contracts':
            value = int(value) if value and str(value).strip() else 1
        elif field == 'credit_debit':
            value = float(value) if value and str(value).strip() else 0.0
        elif field == 'strike_price':
            value = round_standard(float(value), 2) if value and str(value).strip() else 0.0
        elif field == 'current_price':
            value = round_standard(float(value), 2) if value and str(value).strip() else 0.0
        elif field == 'expiration_date':
            value = str(value)  # Date string in YYYY-MM-DD format
        elif field == 'date_trade_open':
            value = str(value)  # Date string in YYYY-MM-DD format
        elif field == 'trade_status':
            value = str(value)
        elif field == 'account_id':
            value = int(value)
        elif field == 'ticker':
            # Ticker needs special handling - update ticker_id instead
            ticker = str(value).upper()
            # Get or create ticker (case-insensitive)
            cursor.execute('SELECT id FROM tickers WHERE UPPER(ticker) = UPPER(?)', (ticker,))
            symbol_row = cursor.fetchone()
            
            if symbol_row:
                symbol_row_dict = safe_row_to_dict(symbol_row)
                ticker_id = symbol_row_dict.get('id')
            else:
                # Create new ticker (store as uppercase)
                cursor.execute('INSERT INTO tickers (ticker, company_name) VALUES (?, ?)', (ticker.upper(), ticker))
                ticker_id = cursor.lastrowid
            
            # Update ticker_id instead of ticker
            db_field_name = 'ticker_id'
            value = ticker_id
        elif field == 'closing_debit':
            value = float(value) if value and str(value).strip() else 0.0
            # Calculate total_debit = closing_debit * num_of_shares
            num_of_shares = trade.get('num_of_shares')
            if num_of_shares:
                total_debit = value * num_of_shares
                updates.append('total_debit = ?')
                params.append(total_debit)
        elif field == 'date_trade_rolled':
            value = str(value)  # Date string in YYYY-MM-DD format
            # Recalculate child trade's DTE, RORC, and ARORC using parent's date_trade_rolled as effective expiration_date
            # This will be handled after the update
        elif field == 'notes':
            value = str(value) if value else None
        
        # Update the field
        updates.append(f'{db_field_name} = ?')
        params.append(value)
        
        # Recalculate dependent fields based on what changed
        if field == 'expiration_date':
            # Recalculate days_to_expiration
            # For child trades, use parent's date_trade_rolled as effective expiration_date
            date_trade_open = trade.get('date_trade_open')
            if date_trade_open:
                from datetime import datetime
                try:
                    date_trade_open_obj = datetime.strptime(date_trade_open, '%Y-%m-%d')
                    # Get effective expiration date (parent's date_trade_rolled for child trades)
                    effective_exp_date = get_effective_expiration_date(cursor, trade)
                    if effective_exp_date:
                        exp_date_obj = datetime.strptime(effective_exp_date, '%Y-%m-%d')
                        days_to_exp = (exp_date_obj - date_trade_open_obj).days
                        updates.append('days_to_expiration = ?')
                        params.append(days_to_exp)
                except:
                    pass  # If date parsing fails, skip DTE calculation
        elif field == 'date_trade_open':
            # Recalculate days_to_expiration when date_trade_open changes
            # For child trades, use parent's date_trade_rolled as effective expiration_date
            from datetime import datetime
            try:
                date_trade_open_obj = datetime.strptime(value, '%Y-%m-%d')
                # Get effective expiration date (parent's date_trade_rolled for child trades)
                effective_exp_date = get_effective_expiration_date(cursor, trade)
                if effective_exp_date:
                    exp_date_obj = datetime.strptime(effective_exp_date, '%Y-%m-%d')
                    days_to_exp = (exp_date_obj - date_trade_open_obj).days
                    updates.append('days_to_expiration = ?')
                    params.append(days_to_exp)
            except:
                pass  # If date parsing fails, skip DTE calculation
            
            # Diagonal entry creation is now handled AFTER the trade update (see below)
        elif field == 'date_trade_rolled':
            # When parent's date_trade_rolled is updated, recalculate child trade's DTE, RORC, and ARORC
            # Find all child trades
            cursor.execute('SELECT * FROM trades WHERE trade_parent_id = ?', (trade_id,))
            child_trades = cursor.fetchall()
            for child_row in child_trades:
                child_trade = safe_row_to_dict(child_row)
                child_trade_id = child_trade.get('id')
                child_date_trade_open = child_trade.get('date_trade_open')
                
                if child_date_trade_open and value:
                    from datetime import datetime
                    try:
                        date_trade_open_obj = datetime.strptime(child_date_trade_open, '%Y-%m-%d')
                        exp_date_obj = datetime.strptime(value, '%Y-%m-%d')  # Use parent's date_trade_rolled
                        days_to_exp = (exp_date_obj - date_trade_open_obj).days
                        
                        # Update child trade's DTE
                        cursor.execute('UPDATE trades SET days_to_expiration = ? WHERE id = ?', (days_to_exp, child_trade_id))
                        
                        # Recalculate child trade's ARORC if it's a ROCT PUT or RULE ONE PUT
                        child_trade_type = child_trade.get('trade_type', '')
                        if 'ROCT PUT' in child_trade_type or 'RULE ONE PUT' in child_trade_type or ('PUT' in child_trade_type and ('ROCT' in child_trade_type or 'RULE ONE' in child_trade_type)):
                            child_net_credit = child_trade.get('net_credit_per_share', 0)
                            child_strike = child_trade.get('strike_price', 0)
                            child_margin_percent = child_trade.get('margin_percent', 100.0)
                            
                            risk_capital_unrounded = child_strike - child_net_credit
                            if risk_capital_unrounded > 0 and days_to_exp > 0 and child_margin_percent > 0:
                                denominator = risk_capital_unrounded * (child_margin_percent / 100.0)
                                if denominator > 0:
                                    arorc_decimal = (365.0 / days_to_exp) * (child_net_credit / denominator)
                                    new_arorc = round_standard(arorc_decimal * 100.0, 1)
                                    cursor.execute('UPDATE trades SET ARORC = ? WHERE id = ?', (new_arorc, child_trade_id))
                    except:
                        pass  # If date parsing fails, skip recalculation
        
        # Recalculate dependent fields based on what changed
        if field == 'num_of_contracts':
            # Update num_of_shares for options trades
            trade_type = trade.get('trade_type', '')
            base_trade_type = trade_type
            # Remove ticker prefix if present
            if ' ' in trade_type:
                base_trade_type = trade_type.split(' ', 1)[1] if ' ' in trade_type else trade_type
            
            if base_trade_type not in ['BTO', 'STC']:
                # For options trades, num_of_shares = num_of_contracts * 100
                new_num_of_shares = value * 100
                updates.append('num_of_shares = ?')
                params.append(new_num_of_shares)
            
            # Recalculate total_premium
            current_credit_debit = trade.get('credit_debit', 0)
            new_total_premium = current_credit_debit * value
            updates.append('total_premium = ?')
            params.append(new_total_premium)
            
            # Recalculate margin_capital
            # Use unrounded risk_capital_per_share for margin_capital calculation
            current_strike = trade.get('strike_price', 0)
            
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                # Calculate unrounded risk_capital_per_share for margin_capital
                current_commission = trade.get('commission_per_share', 0)
                current_net_credit = round_standard((current_credit_debit - current_commission), 5)
                risk_capital_unrounded = current_strike - current_net_credit
                new_margin_capital = value * 100 * risk_capital_unrounded
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
            elif trade_type not in ['BTO', 'STC'] and current_strike > 0:
                current_commission = trade.get('commission_per_share', 0)
                current_net_credit = trade.get('net_credit_per_share', current_credit_debit - current_commission)
                new_margin_capital = (current_strike - current_net_credit) * value * 100
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
        
        elif field == 'credit_debit':
            # Recalculate total_premium
            current_num_contracts = trade.get('num_of_contracts', 1)
            new_total_premium = value * current_num_contracts
            updates.append('total_premium = ?')
            params.append(new_total_premium)
            
            # Recalculate net_credit_per_share (rounded to 5 decimal places)
            current_commission = trade.get('commission_per_share', 0)
            new_net_credit = round_standard((value - current_commission), 5)
            updates.append('net_credit_per_share = ?')
            params.append(new_net_credit)
            
            # Diagonal entry creation is now handled AFTER the trade update (see below)
            
            # Recalculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades
            trade_type = trade.get('trade_type', '')
            current_strike = trade.get('strike_price', 0)
            new_risk_capital = None  # Initialize for ARORC calculation
            
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                new_risk_capital = round_standard((current_strike - new_net_credit), 2)
                updates.append('risk_capital_per_share = ?')
                params.append(new_risk_capital)
                
                # Recalculate margin_capital
                new_margin_capital = current_num_contracts * 100 * new_risk_capital
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
            else:
                updates.append('risk_capital_per_share = ?')
                params.append(None)
                
                # For other options trades, recalculate margin_capital
                if trade_type not in ['BTO', 'STC'] and current_strike > 0:
                    new_margin_capital = (current_strike - new_net_credit) * current_num_contracts * 100
                    updates.append('margin_capital = ?')
                    params.append(new_margin_capital)
            
            # Recalculate ARORC for ROCT PUT and RULE ONE PUT trades
            # margin_percent is stored as a percentage (100 = 100%), so divide by 100 to get decimal multiplier
            # Use unrounded risk_capital_per_share for ARORC calculation
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                # For child trades, use effective expiration date (parent's date_trade_rolled) for DTE calculation
                date_trade_open = trade.get('date_trade_open')
                effective_exp_date = get_effective_expiration_date(cursor, trade)
                days_to_expiration = trade.get('days_to_expiration', 0)
                
                # Recalculate DTE if we have effective expiration date
                if date_trade_open and effective_exp_date:
                    from datetime import datetime
                    try:
                        date_trade_open_obj = datetime.strptime(date_trade_open, '%Y-%m-%d')
                        exp_date_obj = datetime.strptime(effective_exp_date, '%Y-%m-%d')
                        days_to_expiration = (exp_date_obj - date_trade_open_obj).days
                        updates.append('days_to_expiration = ?')
                        params.append(days_to_expiration)
                    except:
                        pass  # If date parsing fails, use existing days_to_expiration
                
                margin_percent = trade.get('margin_percent', 100.0)
                
                # Calculate unrounded risk_capital_per_share for ARORC calculation
                risk_capital_unrounded = current_strike - new_net_credit
                if risk_capital_unrounded > 0 and days_to_expiration > 0 and margin_percent > 0:
                    # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
                    denominator = risk_capital_unrounded * (margin_percent / 100.0)
                    if denominator > 0:
                        # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
                        arorc_decimal = (365.0 / days_to_expiration) * (new_net_credit / denominator)
                        new_arorc = round_standard(arorc_decimal * 100.0, 1)
                        updates.append('ARORC = ?')
                        params.append(new_arorc)
        
        elif field == 'strike_price':
            # Recalculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades
            trade_type = trade.get('trade_type', '')
            current_credit_debit = trade.get('credit_debit', 0)
            current_commission = trade.get('commission_per_share', 0)
            current_net_credit = round_standard((current_credit_debit - current_commission), 5)
            
            if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                new_risk_capital = round_standard((value - current_net_credit), 2)
                updates.append('risk_capital_per_share = ?')
                params.append(new_risk_capital)
                
                # Recalculate margin_capital
                # Use unrounded risk_capital_per_share for margin_capital calculation
                current_num_contracts = trade.get('num_of_contracts', 1)
                risk_capital_unrounded = value - current_net_credit
                new_margin_capital = current_num_contracts * 100 * risk_capital_unrounded
                updates.append('margin_capital = ?')
                params.append(new_margin_capital)
                
                # Recalculate ARORC
                # margin_percent is stored as a percentage (100 = 100%), so divide by 100 to get decimal multiplier
                # Use unrounded risk_capital_per_share for ARORC calculation
                # For child trades, use effective expiration date (parent's date_trade_rolled) for DTE calculation
                date_trade_open = trade.get('date_trade_open')
                effective_exp_date = get_effective_expiration_date(cursor, trade)
                days_to_expiration = trade.get('days_to_expiration', 0)
                
                # Recalculate DTE if we have effective expiration date
                if date_trade_open and effective_exp_date:
                    from datetime import datetime
                    try:
                        date_trade_open_obj = datetime.strptime(date_trade_open, '%Y-%m-%d')
                        exp_date_obj = datetime.strptime(effective_exp_date, '%Y-%m-%d')
                        days_to_expiration = (exp_date_obj - date_trade_open_obj).days
                        updates.append('days_to_expiration = ?')
                        params.append(days_to_expiration)
                    except:
                        pass  # If date parsing fails, use existing days_to_expiration
                
                margin_percent = trade.get('margin_percent', 100.0)
                
                # Calculate unrounded risk_capital_per_share for ARORC calculation
                risk_capital_unrounded = value - current_net_credit
                if risk_capital_unrounded > 0 and days_to_expiration > 0 and margin_percent > 0:
                    # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
                    denominator = risk_capital_unrounded * (margin_percent / 100.0)
                    if denominator > 0:
                        # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
                        arorc_decimal = (365.0 / days_to_expiration) * (current_net_credit / denominator)
                        new_arorc = round_standard(arorc_decimal * 100.0, 1)
                        updates.append('ARORC = ?')
                        params.append(new_arorc)
            else:
                # For other options trades, recalculate margin_capital
                if trade_type not in ['BTO', 'STC'] and value > 0:
                    current_num_contracts = trade.get('num_of_contracts', 1)
                    new_margin_capital = (value - current_net_credit) * current_num_contracts * 100
                    updates.append('margin_capital = ?')
                    params.append(new_margin_capital)
            
            # Diagonal entry creation is now handled AFTER the trade update (see below)
        
        # Execute update
        if updates:
            params.append(trade_id)
            query = f"UPDATE trades SET {', '.join(updates)} WHERE id = ?"
            print(f'[DEBUG] update_trade_field - Executing UPDATE: field={field}, value={value}, trade_id={trade_id}, query={query}, params={params}', flush=True)
            cursor.execute(query, params)
            print(f'[DEBUG] update_trade_field - UPDATE executed, rows affected: {cursor.rowcount}', flush=True)
        else:
            print(f'[DEBUG] update_trade_field - No updates to execute for field={field}, value={value}, trade_id={trade_id}', flush=True)
        
        # After updating the trade (or even if no updates), check if we need to create a diagonal entry for roll trades
        # Get the updated trade to check for roll trade status
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        updated_trade_row = cursor.fetchone()
        if updated_trade_row:
            # Convert Row to dict safely
            updated_trade = safe_row_to_dict(updated_trade_row)
            
            # Check if this is a roll trade (child) and if we need to create/update a diagonal entry
            # This should be done AFTER the trade is updated so we can use the updated values
            # Check for diagonal entry creation/update whenever any relevant field is updated
            trade_parent_id = updated_trade.get('trade_parent_id')
            if trade_parent_id and field in ['strike_price', 'credit_debit', 'expiration_date', 'num_of_contracts', 'date_trade_open', 'current_price', 'ticker', 'account_id']:
                # Get updated values from the updated trade
                new_exp_date = updated_trade.get('expiration_date')
                new_strike = updated_trade.get('strike_price', 0)
                new_credit = updated_trade.get('credit_debit', 0)
                new_num_contracts = updated_trade.get('num_of_contracts', 1)
                
                print(f'[DEBUG] update_trade_field - After update: trade_id={trade_id}, trade_parent_id={trade_parent_id}, new_exp_date={new_exp_date}, new_strike={new_strike}, new_credit={new_credit}')
                
                # Find the parent trade that was rolled
                cursor.execute('''
                    SELECT id, expiration_date, strike_price, trade_type, num_of_contracts
                    FROM trades 
                    WHERE id = ?
                ''', (trade_parent_id,))
                original_trade = cursor.fetchone()
                
                if original_trade:
                    # Convert Row to dict for safe access
                    original_trade_dict = safe_row_to_dict(original_trade)
                    original_exp_date = original_trade_dict.get('expiration_date')
                    original_strike = original_trade_dict.get('strike_price', 0)
                    original_trade_type = original_trade_dict.get('trade_type', '')
                    original_trade_id = original_trade_dict.get('id')
                    print(f'[DEBUG] update_trade_field - After update: original_trade_id={original_trade_id}, original_exp_date={original_exp_date}')
                    
                    # Check if cost basis entry already exists for this roll trade
                    # Match any number of contracts (SELL -1, SELL -2, etc.)
                    cursor.execute('''
                        SELECT id FROM cost_basis 
                        WHERE trade_id = ? AND description LIKE 'SELL -% DIAGONAL%'
                    ''', (trade_id,))
                    existing_entry = cursor.fetchone()
                    
                    # Get ticker symbol
                    ticker_id = updated_trade.get('ticker_id')
                    if ticker_id:
                        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
                        ticker_row = cursor.fetchone()
                        if ticker_row:
                            ticker_row_dict = safe_row_to_dict(ticker_row)
                            ticker_symbol = ticker_row_dict.get('ticker', '')
                        else:
                            ticker_symbol = ''
                    else:
                        ticker_symbol = ''
                    
                    # If diagonal entry exists, update it with current values
                    # If it doesn't exist and we have required values, create it
                    if existing_entry:
                        # Update existing diagonal entry - use current values even if some are 0
                        # This allows updating fields like num_of_contracts, date_trade_open, etc.
                        existing_entry_dict = safe_row_to_dict(existing_entry)
                        diagonal_entry_id = existing_entry_dict.get('id')
                        
                        # Get current values from the existing diagonal entry to use as fallbacks
                        cursor.execute('SELECT description FROM cost_basis WHERE id = ?', (diagonal_entry_id,))
                        existing_diagonal = cursor.fetchone()
                        existing_diagonal_dict = safe_row_to_dict(existing_diagonal)
                        existing_description = existing_diagonal_dict.get('description', '') if existing_diagonal_dict else ''
                        
                        # Import datetime and re for parsing
                        from datetime import datetime
                        import re
                        
                        # Use current values from updated trade, or fall back to original if not set
                        effective_strike = new_strike if new_strike > 0 else (original_strike if original_strike else 0)
                        effective_credit = new_credit if new_credit != 0 else 0
                        effective_exp_date = new_exp_date if new_exp_date else (original_exp_date if original_exp_date else None)
                        
                        # If we don't have required values, try to extract them from existing description
                        if effective_strike == 0 or effective_credit == 0 or not effective_exp_date:
                            # Try to parse from existing description (format: SELL -1 DIAGONAL TICKER 100 DATE1/DATE2 STRIKE1/STRIKE2 PUT @ CREDIT)
                            if effective_credit == 0:
                                match = re.search(r'@\s*([\d.]+)', existing_description)
                                if match:
                                    effective_credit = float(match.group(1))
                            if effective_strike == 0:
                                match = re.search(r'(\d+\.?\d*)/(\d+\.?\d*)\s+(PUT|CALL)', existing_description)
                                if match:
                                    # First number is child strike, second is parent strike
                                    effective_strike = float(match.group(1))
                            if not effective_exp_date:
                                # Try to extract date from description (format: DD-MMM-YY/DD-MMM-YY)
                                match = re.search(r'(\d{2}-[A-Z]{3}-\d{2})/(\d{2}-[A-Z]{3}-\d{2})', existing_description)
                                if match:
                                    # First date is child expiration, second is parent expiration
                                    try:
                                        child_date_str = match.group(1)
                                        # Convert DD-MMM-YY to YYYY-MM-DD
                                        child_date = datetime.strptime(child_date_str, '%d-%b-%y')
                                        effective_exp_date = child_date.strftime('%Y-%m-%d')
                                    except:
                                        pass
                        
                        # Only update if we have minimum required values
                        if effective_strike > 0 and effective_credit != 0 and effective_exp_date:
                            print(f'[DEBUG] update_trade_field - After update: Updating existing diagonal entry')
                            # Update the existing diagonal entry with new values
                            
                            # Format dates as DD-MMM-YY
                            try:
                                new_exp = datetime.strptime(effective_exp_date, '%Y-%m-%d')
                                new_exp_formatted = new_exp.strftime('%d-%b-%y').upper()
                            except:
                                new_exp_formatted = effective_exp_date
                            
                            try:
                                orig_exp = datetime.strptime(original_exp_date, '%Y-%m-%d')
                                orig_exp_formatted = orig_exp.strftime('%d-%b-%y').upper()
                            except:
                                orig_exp_formatted = original_exp_date
                            
                            # Determine if it's PUT or CALL based on trade_type
                            is_put = 'PUT' in original_trade_type or 'ROP' in original_trade_type
                            is_call = 'CALL' in original_trade_type or 'ROC' in original_trade_type
                            
                            # Create updated description using effective values
                            if is_put:
                                new_description = f"SELL -{new_num_contracts} DIAGONAL {ticker_symbol} 100 {new_exp_formatted}/{orig_exp_formatted} {effective_strike}/{original_strike} PUT @ {effective_credit}"
                            elif is_call:
                                new_description = f"SELL -{new_num_contracts} DIAGONAL {ticker_symbol} 100 {new_exp_formatted}/{orig_exp_formatted} {effective_strike}/{original_strike} CALL @ {effective_credit}"
                            else:
                                new_description = f"SELL -{new_num_contracts} DIAGONAL {ticker_symbol} 100 {new_exp_formatted}/{orig_exp_formatted} {effective_strike}/{original_strike} {original_trade_type} @ {effective_credit}"
                            
                            # Recalculate total_amount for diagonal entry
                            # For diagonal roll trades: total_amount = -effective_credit * new_num_contracts * 100
                            new_total_amount = -(effective_credit * new_num_contracts * 100)
                            
                            # Get the previous entry's running totals (before this entry)
                            date_trade_open = updated_trade.get('date_trade_open')
                            if not date_trade_open:
                                print(f'[DEBUG] update_trade_field - date_trade_open is None or empty for trade_id={trade_id}, skipping diagonal entry update')
                                # Skip the update if date_trade_open is missing
                            else:
                                cursor.execute('''
                                    SELECT running_basis, running_shares 
                                    FROM cost_basis 
                                    WHERE ticker_id = ? AND account_id = ? AND transaction_date < ?
                                    ORDER BY transaction_date DESC, rowid DESC
                                    LIMIT 1
                                ''', (updated_trade.get('ticker_id'), updated_trade.get('account_id'), date_trade_open))
                                prev_entry = cursor.fetchone()
                                
                                if prev_entry:
                                    prev_entry_dict = safe_row_to_dict(prev_entry)
                                    prev_running_basis = prev_entry_dict.get('running_basis', 0)
                                    prev_running_shares = prev_entry_dict.get('running_shares', 0)
                                else:
                                    prev_running_basis = 0
                                    prev_running_shares = 0
                                
                                # Recalculate running totals for this entry
                                # For diagonal trades: shares = 0, so running_shares stays the same
                                new_running_basis = prev_running_basis + new_total_amount
                                new_running_shares = prev_running_shares  # shares is 0 for options
                                new_basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
                                
                                # Update the diagonal entry
                                cursor.execute('''
                                    UPDATE cost_basis 
                                    SET description = ?, total_amount = ?, running_basis = ?, running_shares = ?, basis_per_share = ?,
                                        transaction_date = ?
                                    WHERE id = ?
                                ''', (new_description, new_total_amount, new_running_basis, new_running_shares, new_basis_per_share, date_trade_open, diagonal_entry_id))
                                
                                # Get the rowid of the diagonal entry for ordering subsequent entries
                                cursor.execute('SELECT rowid FROM cost_basis WHERE id = ?', (diagonal_entry_id,))
                                diagonal_rowid = cursor.fetchone()
                                diagonal_rowid_dict = safe_row_to_dict(diagonal_rowid)
                                diagonal_rowid_value = diagonal_rowid_dict.get('rowid') if diagonal_rowid_dict else None
                                
                                # Recalculate running totals for all subsequent entries
                                if diagonal_rowid_value:
                                    cursor.execute('''
                                        SELECT id, total_amount, shares, transaction_date, rowid
                                        FROM cost_basis 
                                        WHERE ticker_id = ? AND account_id = ? AND (transaction_date > ? OR (transaction_date = ? AND rowid > ?))
                                        ORDER BY transaction_date ASC, rowid ASC
                                    ''', (updated_trade.get('ticker_id'), updated_trade.get('account_id'), date_trade_open, date_trade_open, diagonal_rowid_value))
                                else:
                                    # Fallback: use id for ordering if rowid is not available
                                    cursor.execute('''
                                        SELECT id, total_amount, shares, transaction_date, rowid
                                        FROM cost_basis 
                                        WHERE ticker_id = ? AND account_id = ? AND (transaction_date > ? OR (transaction_date = ? AND id > ?))
                                        ORDER BY transaction_date ASC, id ASC
                                    ''', (updated_trade.get('ticker_id'), updated_trade.get('account_id'), date_trade_open, date_trade_open, diagonal_entry_id))
                                subsequent_entries = cursor.fetchall()
                                
                                # Start with the updated running totals from this entry
                                running_basis = new_running_basis
                                running_shares = new_running_shares
                                
                                for entry in subsequent_entries:
                                    entry_dict = safe_row_to_dict(entry)
                                    running_basis += entry_dict.get('total_amount', 0)
                                    running_shares += entry_dict.get('shares', 0)
                                    basis_per_share = running_basis / running_shares if running_shares != 0 else running_basis
                                    
                                    cursor.execute('''
                                        UPDATE cost_basis 
                                        SET running_basis = ?, running_shares = ?, basis_per_share = ?
                                        WHERE id = ?
                                    ''', (running_basis, running_shares, basis_per_share, entry_dict.get('id')))
                                
                                print(f'[DEBUG] update_trade_field - Updated diagonal entry {diagonal_entry_id} with new values')
                        else:
                            print(f'[DEBUG] update_trade_field - After update: Conditions not met for existing entry - effective_strike={effective_strike}, effective_credit={effective_credit}, effective_exp_date={effective_exp_date}')
                    elif new_strike > 0 and new_credit != 0 and new_exp_date:
                        # Create new diagonal entry if it doesn't exist and we have required values
                        print(f'[DEBUG] update_trade_field - After update: Creating diagonal entry')
                        create_roll_diagonal_cost_basis_entry(
                            cursor, trade_id, original_trade_id, updated_trade.get('account_id'), 
                            updated_trade.get('ticker_id'), updated_trade.get('date_trade_open'), ticker_symbol, new_exp_date, original_exp_date,
                            new_strike, original_strike, new_credit, original_trade_type, new_num_contracts
                        )
                    else:
                        print(f'[DEBUG] update_trade_field - After update: Conditions not met for creation - strike={new_strike}, credit={new_credit}, exp_date={new_exp_date}')
                else:
                    print(f'[DEBUG] update_trade_field - After update: Parent trade not found - parent={original_trade is not None}')
            
            # Check if this is a parent trade that has roll children - update their diagonal entries
            # When parent trade fields change, we need to update all child trades' diagonal entries
            if field in ['expiration_date', 'credit_debit', 'strike_price']:
                # Find all child trades (roll trades) that have this trade as their parent
                cursor.execute('''
                    SELECT id, expiration_date, strike_price, credit_debit, num_of_contracts, account_id, ticker_id, date_trade_open
                    FROM trades 
                    WHERE trade_parent_id = ?
                ''', (trade_id,))
                child_trades = cursor.fetchall()
                
                if child_trades:
                    print(f'[DEBUG] update_trade_field - Found {len(child_trades)} child trades for parent trade_id={trade_id}')
                    
                    # Get updated parent values - use the new value for the field being updated
                    if field == 'expiration_date':
                        parent_exp_date = value  # Use the new value
                    else:
                        parent_exp_date = updated_trade.get('expiration_date')
                    
                    if field == 'strike_price':
                        parent_strike = float(value) if value and str(value).strip() else 0  # Use the new value
                    else:
                        parent_strike = updated_trade.get('strike_price', 0)
                    
                    parent_trade_type = updated_trade.get('trade_type', '')
                    
                    # Get ticker symbol
                    ticker_id = updated_trade.get('ticker_id')
                    if ticker_id:
                        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
                        ticker_row = cursor.fetchone()
                        ticker_row_dict = safe_row_to_dict(ticker_row)
                        ticker_symbol = ticker_row_dict.get('ticker', '') if ticker_row_dict else ''
                    else:
                        ticker_symbol = ''
                    
                    for child_trade_row in child_trades:
                        child_trade = safe_row_to_dict(child_trade_row)
                        child_trade_id = child_trade.get('id')
                        child_exp_date = child_trade.get('expiration_date')
                        child_strike = child_trade.get('strike_price', 0)
                        child_credit = child_trade.get('credit_debit', 0)
                        child_num_contracts = child_trade.get('num_of_contracts', 1)
                        
                        # Only update if child trade has valid values and parent has valid values
                        if child_strike > 0 and child_credit != 0 and child_exp_date and parent_exp_date:
                            # Find the diagonal entry for this child trade
                            cursor.execute('''
                                SELECT id FROM cost_basis 
                                WHERE trade_id = ? AND description LIKE 'SELL -% DIAGONAL%'
                            ''', (child_trade_id,))
                            diagonal_entry = cursor.fetchone()
                            
                            if diagonal_entry:
                                diagonal_entry_dict = safe_row_to_dict(diagonal_entry)
                                diagonal_entry_id = diagonal_entry_dict.get('id')
                                print(f'[DEBUG] update_trade_field - Updating diagonal entry {diagonal_entry_id} for child trade {child_trade_id} with new parent values')
                                
                                # Format dates as DD-MMM-YY
                                from datetime import datetime
                                try:
                                    child_exp = datetime.strptime(child_exp_date, '%Y-%m-%d')
                                    child_exp_formatted = child_exp.strftime('%d-%b-%y').upper()
                                except:
                                    child_exp_formatted = child_exp_date
                                
                                try:
                                    parent_exp = datetime.strptime(parent_exp_date, '%Y-%m-%d')
                                    parent_exp_formatted = parent_exp.strftime('%d-%b-%y').upper()
                                except:
                                    parent_exp_formatted = parent_exp_date
                                
                                # Determine if it's PUT or CALL based on parent trade_type
                                is_put = 'PUT' in parent_trade_type or 'ROP' in parent_trade_type
                                is_call = 'CALL' in parent_trade_type or 'ROC' in parent_trade_type
                                
                                # Create updated description with new parent values
                                if is_put:
                                    new_description = f"SELL -{child_num_contracts} DIAGONAL {ticker_symbol} 100 {child_exp_formatted}/{parent_exp_formatted} {child_strike}/{parent_strike} PUT @ {child_credit}"
                                elif is_call:
                                    new_description = f"SELL -{child_num_contracts} DIAGONAL {ticker_symbol} 100 {child_exp_formatted}/{parent_exp_formatted} {child_strike}/{parent_strike} CALL @ {child_credit}"
                                else:
                                    new_description = f"SELL -{child_num_contracts} DIAGONAL {ticker_symbol} 100 {child_exp_formatted}/{parent_exp_formatted} {child_strike}/{parent_strike} {parent_trade_type} @ {child_credit}"
                                
                                # Recalculate total_amount (unchanged, based on child credit)
                                new_total_amount = -(child_credit * child_num_contracts * 100)
                                
                                # Get the previous entry's running totals (before this entry)
                                child_date_trade_open = child_trade.get('date_trade_open')
                                cursor.execute('''
                                    SELECT running_basis, running_shares 
                                    FROM cost_basis 
                                    WHERE ticker_id = ? AND account_id = ? AND transaction_date < ?
                                    ORDER BY transaction_date DESC, rowid DESC
                                    LIMIT 1
                                ''', (child_trade.get('ticker_id'), child_trade.get('account_id'), child_date_trade_open))
                                prev_entry = cursor.fetchone()
                                
                                if prev_entry:
                                    prev_entry_dict = safe_row_to_dict(prev_entry)
                                    prev_running_basis = prev_entry_dict.get('running_basis', 0)
                                    prev_running_shares = prev_entry_dict.get('running_shares', 0)
                                else:
                                    prev_running_basis = 0
                                    prev_running_shares = 0
                                
                                # Recalculate running totals for this entry
                                new_running_basis = prev_running_basis + new_total_amount
                                new_running_shares = prev_running_shares  # shares is 0 for options
                                new_basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
                                
                                # Update the diagonal entry
                                cursor.execute('''
                                    UPDATE cost_basis 
                                    SET description = ?, total_amount = ?, running_basis = ?, running_shares = ?, basis_per_share = ?
                                    WHERE id = ?
                                ''', (new_description, new_total_amount, new_running_basis, new_running_shares, new_basis_per_share, diagonal_entry_id))
                                
                                # Recalculate running totals for all subsequent entries
                                cursor.execute('SELECT rowid FROM cost_basis WHERE id = ?', (diagonal_entry_id,))
                                diagonal_rowid = cursor.fetchone()
                                if diagonal_rowid:
                                    diagonal_rowid_dict = safe_row_to_dict(diagonal_rowid)
                                    diagonal_rowid_value = diagonal_rowid_dict.get('rowid')
                                else:
                                    diagonal_rowid_value = None
                                
                                if diagonal_rowid_value:
                                    cursor.execute('''
                                        SELECT id, total_amount, shares, transaction_date, rowid
                                        FROM cost_basis 
                                        WHERE ticker_id = ? AND account_id = ? AND (transaction_date > ? OR (transaction_date = ? AND rowid > ?))
                                        ORDER BY transaction_date ASC, rowid ASC
                                    ''', (child_trade.get('ticker_id'), child_trade.get('account_id'), child_date_trade_open, child_date_trade_open, diagonal_rowid_value))
                                else:
                                    cursor.execute('''
                                        SELECT id, total_amount, shares, transaction_date, rowid
                                        FROM cost_basis 
                                        WHERE ticker_id = ? AND account_id = ? AND (transaction_date > ? OR (transaction_date = ? AND id > ?))
                                        ORDER BY transaction_date ASC, id ASC
                                    ''', (child_trade.get('ticker_id'), child_trade.get('account_id'), child_date_trade_open, child_date_trade_open, diagonal_entry_id))
                                subsequent_entries = cursor.fetchall()
                                
                                # Start with the updated running totals from this entry
                                running_basis = new_running_basis
                                running_shares = new_running_shares
                                
                                for entry in subsequent_entries:
                                    entry_dict = safe_row_to_dict(entry)
                                    running_basis += entry_dict.get('total_amount', 0)
                                    running_shares += entry_dict.get('shares', 0)
                                    basis_per_share = running_basis / running_shares if running_shares != 0 else running_basis
                                    
                                    cursor.execute('''
                                        UPDATE cost_basis 
                                        SET running_basis = ?, running_shares = ?, basis_per_share = ?
                                        WHERE id = ?
                                    ''', (running_basis, running_shares, basis_per_share, entry_dict.get('id')))
                                
                                print(f'[DEBUG] update_trade_field - Updated diagonal entry {diagonal_entry_id} for child trade {child_trade_id} with new parent values')
            
            # Update cash_flows entries for this trade
            # Cash flows are linked to trades via trade_id
            # Update amount if credit_debit or num_of_contracts changed
            # Update account_id if account_id changed
            if field in ['credit_debit', 'num_of_contracts', 'account_id']:
                # Get all cash flows for this trade
                cursor.execute('SELECT * FROM cash_flows WHERE trade_id = ?', (trade_id,))
                cash_flows = cursor.fetchall()
                
                for cf in cash_flows:
                    cf_dict = safe_row_to_dict(cf)
                    # Update account_id if account_id changed
                    if field == 'account_id':
                        cursor.execute('''
                            UPDATE cash_flows 
                            SET account_id = ?
                            WHERE id = ?
                        ''', (updated_trade.get('account_id'), cf_dict.get('id')))
                    # Recalculate amount based on updated trade values
                    elif cf_dict.get('transaction_type') in ['PREMIUM_CREDIT', 'PREMIUM_DEBIT']:
                        # Amount = credit_debit * num_of_contracts * 100
                        new_amount = updated_trade.get('credit_debit', 0) * updated_trade.get('num_of_contracts', 1) * 100
                        cursor.execute('''
                            UPDATE cash_flows 
                            SET amount = ?
                            WHERE id = ?
                        ''', (new_amount, cf_dict.get('id')))
            
            # Update cost_basis entries for this trade
            # Cost basis entries are linked to trades via trade_id
            # Update description, shares, cost_per_share, total_amount if relevant fields changed
            # Also update account_id if account_id changed
            if field in ['num_of_contracts', 'credit_debit', 'strike_price', 'expiration_date', 'date_trade_open', 'ticker', 'current_price', 'account_id']:
                # Get all cost_basis entries for this trade
                # Only update existing entries - do NOT create new ones
                cursor.execute('SELECT * FROM cost_basis WHERE trade_id = ?', (trade_id,))
                cost_basis_entries = cursor.fetchall()
                
                # If account_id changed, update account_id for all cost_basis entries
                if field == 'account_id':
                    for cb in cost_basis_entries:
                        cb_dict = safe_row_to_dict(cb)
                        cursor.execute('''
                            UPDATE cost_basis 
                            SET account_id = ?
                            WHERE id = ?
                        ''', (updated_trade.get('account_id'), cb_dict.get('id')))
                
                # If no cost_basis entries exist, check if this is a roll trade
                # Roll trades should only have diagonal entries, not regular entries
                if not cost_basis_entries:
                    # Check if this is a roll trade (has trade_parent_id)
                    trade_parent_id = updated_trade.get('trade_parent_id')
                    if trade_parent_id:
                        # This is a roll trade - don't create regular cost basis entries
                        # The diagonal entry should have been created above
                        print(f'[DEBUG] update_trade_field - No cost_basis entries found for roll trade_id={trade_id}, skipping regular entry creation')
                    else:
                        # This is not a roll trade - don't create new entries here
                        # Cost_basis entries should only be created when the trade is first created
                        print(f'[DEBUG] update_trade_field - No cost_basis entries found for trade_id={trade_id}, skipping update')
                else:
                    # Get ticker symbol and account_id for recalculating running totals
                    ticker_id = updated_trade.get('ticker_id')
                    if ticker_id:
                        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
                        ticker_row = cursor.fetchone()
                        if ticker_row:
                            ticker_row_dict = safe_row_to_dict(ticker_row)
                            ticker_symbol = ticker_row_dict.get('ticker', '')
                        else:
                            ticker_symbol = ''
                    else:
                        ticker_symbol = ''
                    account_id = updated_trade.get('account_id')
                    
                    # Check if this is a roll trade - if so, skip updating cost basis entries
                    # Roll trades should only have diagonal entries, which should not be updated
                    trade_parent_id = updated_trade.get('trade_parent_id')
                    if trade_parent_id:
                        # This is a roll trade - skip updating cost basis entries
                        # The diagonal entry should have been created/updated above
                        print(f'[DEBUG] update_trade_field - Roll trade_id={trade_id} has cost_basis entries, but skipping regular update (diagonal entries should not be updated)')
                    else:
                        # Not a roll trade - update existing cost basis entries
                        for cb in cost_basis_entries:
                            cb_dict = safe_row_to_dict(cb)
                            # Skip diagonal entries - they should not be updated
                            if 'DIAGONAL' in cb_dict.get('description', ''):
                                print(f'[DEBUG] update_trade_field - Skipping diagonal entry update for trade_id={trade_id}')
                                continue
                            
                            # Recalculate based on trade type
                            trade_type = updated_trade.get('trade_type', '')
                            
                            if trade_type in ['BTO', 'STC']:
                                # For BTO/STC trades, update shares and total_amount
                                new_shares = updated_trade.get('num_of_contracts', 1)
                                if trade_type == 'STC':
                                    new_shares = -new_shares
                                new_total_amount = updated_trade.get('total_premium', 0)
                                if trade_type == 'STC':
                                    new_total_amount = -abs(new_total_amount)
                                
                                new_description = f"{trade_type} {abs(new_shares)} {ticker_symbol}"
                                # Update cost_per_share based on current_price (price_per_share)
                                # For BTO/STC, price_per_share = current_price
                                new_cost_per_share = updated_trade.get('current_price', updated_trade.get('price_per_share', 0))
                                
                                # Get the previous entry's running totals (before this entry)
                                cursor.execute('''
                                    SELECT running_basis, running_shares 
                                    FROM cost_basis 
                                    WHERE ticker_id = ? AND account_id = ? AND transaction_date < ?
                                    ORDER BY transaction_date DESC, rowid DESC
                                    LIMIT 1
                                ''', (ticker_id, account_id, cb_dict.get('transaction_date')))
                                prev_entry = cursor.fetchone()
                                
                                if prev_entry:
                                    prev_entry_dict = safe_row_to_dict(prev_entry)
                                    prev_running_basis = prev_entry_dict.get('running_basis', 0)
                                    prev_running_shares = prev_entry_dict.get('running_shares', 0)
                                else:
                                    prev_running_basis = 0
                                    prev_running_shares = 0
                                
                                # Recalculate running totals for this entry
                                new_running_basis = prev_running_basis + new_total_amount
                                if trade_type == 'STC':
                                    new_running_shares = prev_running_shares - updated_trade.get('num_of_contracts', 1)
                                else:  # BTO
                                    new_running_shares = prev_running_shares + updated_trade.get('num_of_contracts', 1)
                                
                                new_basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
                                
                                cursor.execute('''
                                    UPDATE cost_basis 
                                    SET description = ?, shares = ?, cost_per_share = ?, total_amount = ?,
                                        running_basis = ?, running_shares = ?, basis_per_share = ?
                                    WHERE id = ?
                                ''', (new_description, new_shares, new_cost_per_share, new_total_amount,
                                      new_running_basis, new_running_shares, new_basis_per_share, cb_dict.get('id')))
                            else:
                                # For options trades, update description with new strike/premium/expiration
                                expiration_date = updated_trade.get('expiration_date', '')
                                strike_price = updated_trade.get('strike_price', 0)
                                premium = updated_trade.get('credit_debit', 0)
                                num_contracts = updated_trade.get('num_of_contracts', 1)
                                
                                # Format expiration date as DD-MMM-YY (matching create_options_cost_basis_entry format)
                                from datetime import datetime
                                try:
                                    exp_date_obj = datetime.strptime(expiration_date, '%Y-%m-%d')
                                    expiration_formatted = exp_date_obj.strftime('%d-%b-%y').upper()
                                except:
                                    expiration_formatted = expiration_date
                                
                                # Format strike_price and premium to 2 decimal places (matching create_options_cost_basis_entry)
                                strike_str = f"{strike_price:.2f}" if strike_price else "0.0"
                                premium_str = f"{premium:.2f}" if premium else "0.0"
                                
                                # Build description matching create_options_cost_basis_entry format
                                if 'ROP' in trade_type or 'PUT' in trade_type:
                                    new_description = f"SELL -{num_contracts} {ticker_symbol} 100 {expiration_formatted} {strike_str} PUT @{premium_str}"
                                elif 'ROC' in trade_type or 'CALL' in trade_type:
                                    new_description = f"SELL -{num_contracts} {ticker_symbol} 100 {expiration_formatted} {strike_str} CALL @{premium_str}"
                                else:
                                    new_description = f"SELL -{num_contracts} {ticker_symbol} 100 {expiration_formatted} {strike_str} {trade_type.split()[0]} @{premium_str}"
                                
                                # Update transaction_date if date_trade_open changed
                                date_trade_open = updated_trade.get('date_trade_open', cb_dict.get('transaction_date'))
                                
                                # Recalculate total_amount for options trades
                                # For options: total_amount = -(premium * num_of_contracts * 100)
                                new_total_amount = -(premium * num_contracts * 100)
                                
                                # Get the previous entry's running totals (before this entry)
                                cursor.execute('''
                                    SELECT running_basis, running_shares 
                                    FROM cost_basis 
                                    WHERE ticker_id = ? AND account_id = ? AND transaction_date < ?
                                    ORDER BY transaction_date DESC, rowid DESC
                                    LIMIT 1
                                ''', (ticker_id, account_id, date_trade_open))
                                prev_entry = cursor.fetchone()
                                
                                if prev_entry:
                                    prev_entry_dict = safe_row_to_dict(prev_entry)
                                    prev_running_basis = prev_entry_dict.get('running_basis', 0)
                                    prev_running_shares = prev_entry_dict.get('running_shares', 0)
                                else:
                                    prev_running_basis = 0
                                    prev_running_shares = 0
                                
                                # Recalculate running totals for options trades
                                # For options: shares = 0, so running_shares stays the same
                                new_running_basis = prev_running_basis + new_total_amount
                                new_running_shares = prev_running_shares  # Options don't change shares
                                new_basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else new_running_basis
                                
                                cursor.execute('''
                                    UPDATE cost_basis 
                                    SET description = ?, transaction_date = ?, total_amount = ?,
                                        running_basis = ?, running_shares = ?, basis_per_share = ?
                                    WHERE id = ?
                                ''', (new_description, date_trade_open, new_total_amount,
                                      new_running_basis, new_running_shares, new_basis_per_share, cb_dict['id']))
                        
                        # After updating all entries, recalculate running totals for ALL subsequent entries
                        # Get all entries for this ticker/account ordered by transaction_date
                        cursor.execute('''
                            SELECT id, total_amount, shares, transaction_date, rowid
                            FROM cost_basis 
                            WHERE ticker_id = ? AND account_id = ?
                            ORDER BY transaction_date ASC, rowid ASC
                        ''', (ticker_id, account_id))
                        all_entries = cursor.fetchall()
                        
                        # Recalculate running totals sequentially
                        running_basis = 0
                        running_shares = 0
                        for entry in all_entries:
                            entry_dict = safe_row_to_dict(entry)
                            running_basis += entry_dict.get('total_amount', 0)
                            running_shares += entry_dict.get('shares', 0)
                            basis_per_share = running_basis / running_shares if running_shares != 0 else running_basis
                            
                            cursor.execute('''
                                UPDATE cost_basis 
                                SET running_basis = ?, running_shares = ?, basis_per_share = ?
                                WHERE id = ?
                            ''', (running_basis, running_shares, basis_per_share, entry_dict.get('id')))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        error_type = type(e).__name__
        error_msg = str(e)
        traceback_str = traceback.format_exc()
        print(f'[ERROR] update_trade_field - Error type: {error_type}, Message: {error_msg}', flush=True)
        print(f'[ERROR] update_trade_field - Traceback:\n{traceback_str}', flush=True)
        # Check if it's a KeyError or IndexError with "No item with that key" message
        if (error_type == 'KeyError' or error_type == 'IndexError') and 'No item with that key' in error_msg:
            print(f'[ERROR] update_trade_field - {error_type} detected! This suggests a Row object was accessed with bracket notation.', flush=True)
        return jsonify({'error': f'Failed to update trade field: {error_type}: {error_msg}'}), 500

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

def get_company_name_from_yfinance(ticker):
    """
    Helper function to fetch company name from yfinance.
    Returns company name or None if not found.
    """
    try:
        import yfinance as yf
        stock = yf.Ticker(ticker.upper())
        info = stock.info
        company_name = info.get('longName') or info.get('shortName') or info.get('name')
        return company_name
    except Exception as e:
        print(f'[YFINANCE] Error fetching company name for {ticker}: {e}', flush=True)
        return None

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
        
        # Not cached, fetch from yfinance
        company_name = get_company_name_from_yfinance(ticker)
        
        if company_name:
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
            conn.close()
            return jsonify({
                'symbol': ticker.upper(),
                'name': company_name
            })
        else:
            # Fallback to ticker symbol if yfinance fails
            conn.close()
            return jsonify({
                'symbol': ticker.upper(),
                'name': ticker.upper()
            })
    except ImportError:
        return jsonify({
            'error': 'yfinance library not installed. Please install it with: pip install yfinance==0.2.32'
        }), 500
    except Exception as e:
        print(f'Error getting company info: {e}', flush=True)
        import traceback
        print(f'Traceback: {traceback.format_exc()}', flush=True)
        return jsonify({'symbol': ticker.upper(), 'name': ticker.upper()})

@app.route('/api/pending-tickers/update', methods=['POST'])
def update_pending_tickers():
    """Update company names for tickers marked as needing update using yfinance"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all tickers that need updating (needs_update = 1, or missing company_name, or company_name = ticker)
        cursor.execute('SELECT ticker FROM tickers WHERE needs_update = 1 OR company_name IS NULL OR company_name = ticker LIMIT 50')
        pending_tickers = cursor.fetchall()
        
        if not pending_tickers:
            conn.close()
            return jsonify({'updated': 0, 'message': 'No pending tickers'})
        
        updated_count = 0
        errors = []
        
        for ticker_row in pending_tickers:
            ticker = ticker_row['ticker']
            
            try:
                company_name = get_company_name_from_yfinance(ticker)
                
                if company_name:
                    cursor.execute('''
                        UPDATE tickers 
                        SET company_name = ?, needs_update = 0
                        WHERE ticker = ?
                    ''', (company_name, ticker))
                    conn.commit()
                    updated_count += 1
                    print(f'[PENDING TICKERS] Updated {ticker}: {company_name}', flush=True)
                else:
                    print(f'[PENDING TICKERS] Could not fetch company name for {ticker}', flush=True)
            except Exception as e:
                error_msg = f'Error updating {ticker}: {str(e)}'
                print(f'[PENDING TICKERS] {error_msg}', flush=True)
                errors.append(error_msg)
                continue
        
        conn.close()
        return jsonify({
            'updated': updated_count,
            'message': f'Updated {updated_count} tickers',
            'errors': errors
        })
    except ImportError:
        return jsonify({
            'error': 'yfinance library not installed. Please install it with: pip install yfinance==0.2.32'
        }), 500
    except Exception as e:
        import traceback
        print(f'[PENDING TICKERS] Error: {e}', flush=True)
        print(f'[PENDING TICKERS] Traceback: {traceback.format_exc()}', flush=True)
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
                   MAX(CASE WHEN st.trade_status IN ('assigned', 'expired') THEN st.date_trade_open ELSE NULL END) as last_assigned_expired_date
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
        
        # Get account_id filter if provided - handle both string and int conversion
        account_id_arg = request.args.get('account_id')
        account_id = None
        if account_id_arg:
            try:
                account_id = int(account_id_arg)
            except (ValueError, TypeError):
                account_id = None
        
        print(f'[DEBUG] Cost basis query - account_id_arg: {account_id_arg}, account_id: {account_id}')
        
        # Query cost_basis table directly instead of trades table
        # Also include dividend entries from cash_flows table
        if ticker:
            # Query cost_basis entries - explicitly list all columns to match UNION structure
            query = '''
                SELECT 
                    cb.id, cb.account_id, cb.ticker_id, cb.trade_id, cb.cash_flow_id,
                    cb.transaction_date, cb.description, cb.shares, cb.cost_per_share,
                    cb.total_amount, cb.running_basis, cb.running_shares, cb.basis_per_share, cb.created_at,
                    t.ticker, tr.trade_status as status, tr.trade_type, a.account_name, 'cost_basis' as entry_type
                FROM cost_basis cb
                JOIN tickers t ON cb.ticker_id = t.id
                LEFT JOIN trades tr ON cb.trade_id = tr.id
                LEFT JOIN accounts a ON cb.account_id = a.id
                WHERE t.ticker = ? AND t.ticker IS NOT NULL AND t.ticker != ""
            '''
            params = [ticker]
            if account_id:
                query += ' AND cb.account_id = ?'
                params.append(account_id)
            
            # Query dividend entries from cash_flows - match column structure exactly
            dividend_query = '''
                SELECT 
                    cf.id, cf.account_id, t.id as ticker_id, NULL as trade_id, cf.id as cash_flow_id,
                    cf.transaction_date, cf.description, 0 as shares, 0 as cost_per_share,
                    cf.amount as total_amount, 0 as running_basis, 0 as running_shares, 0 as basis_per_share, cf.created_at,
                    t.ticker, NULL as status, NULL as trade_type, a.account_name, 'dividend' as entry_type
                FROM cash_flows cf
                JOIN tickers t ON cf.ticker_id = t.id
                LEFT JOIN accounts a ON cf.account_id = a.id
                WHERE t.ticker = ? AND cf.transaction_type = 'Dividend'
            '''
            dividend_params = [ticker]
            if account_id:
                dividend_query += ' AND cf.account_id = ?'
                dividend_params.append(account_id)
            
            # Combine both queries with UNION
            combined_query = f'''
                {query}
                UNION ALL
                {dividend_query}
                ORDER BY transaction_date ASC
            '''
            combined_params = params + dividend_params
            cursor.execute(combined_query, combined_params)
        else:
            # Query cost_basis entries - explicitly list all columns to match UNION structure
            query = '''
                SELECT 
                    cb.id, cb.account_id, cb.ticker_id, cb.trade_id, cb.cash_flow_id,
                    cb.transaction_date, cb.description, cb.shares, cb.cost_per_share,
                    cb.total_amount, cb.running_basis, cb.running_shares, cb.basis_per_share, cb.created_at,
                    t.ticker, tr.trade_status as status, tr.trade_type, a.account_name, 'cost_basis' as entry_type
                FROM cost_basis cb
                JOIN tickers t ON cb.ticker_id = t.id
                LEFT JOIN trades tr ON cb.trade_id = tr.id
                LEFT JOIN accounts a ON cb.account_id = a.id
                WHERE t.ticker IS NOT NULL AND t.ticker != ""
            '''
            params = []
            if account_id:
                query += ' AND cb.account_id = ?'
                params.append(account_id)
            
            # Query dividend entries from cash_flows - match column structure exactly
            dividend_query = '''
                SELECT 
                    cf.id, cf.account_id, t.id as ticker_id, NULL as trade_id, cf.id as cash_flow_id,
                    cf.transaction_date, cf.description, 0 as shares, 0 as cost_per_share,
                    cf.amount as total_amount, 0 as running_basis, 0 as running_shares, 0 as basis_per_share, cf.created_at,
                    t.ticker, NULL as status, NULL as trade_type, a.account_name, 'dividend' as entry_type
                FROM cash_flows cf
                JOIN tickers t ON cf.ticker_id = t.id
                LEFT JOIN accounts a ON cf.account_id = a.id
                WHERE cf.transaction_type = 'Dividend'
            '''
            dividend_params = []
            if account_id:
                dividend_query += ' AND cf.account_id = ?'
                dividend_params.append(account_id)
            
            # Combine both queries with UNION
            combined_query = f'''
                {query}
                UNION ALL
                {dividend_query}
                ORDER BY t.ticker, transaction_date ASC
            '''
            combined_params = params + dividend_params
            cursor.execute(combined_query, combined_params)
        
        cost_basis_entries = cursor.fetchall()
        
        print(f'[DEBUG] Cost basis query returned {len(cost_basis_entries)} entries')
        if cost_basis_entries:
            sample_entry = dict(cost_basis_entries[0])
            print(f'[DEBUG] First entry - account_id: {sample_entry.get("account_id")}, account_name: {sample_entry.get("account_name")}, ticker: {sample_entry.get("ticker")}')
            # Log all unique account_ids in the results
            unique_accounts = set()
            for entry in cost_basis_entries:
                entry_dict = dict(entry)
                unique_accounts.add((entry_dict.get("account_id"), entry_dict.get("account_name")))
            print(f'[DEBUG] Unique accounts in query results: {unique_accounts}')
        
        # Convert to list of dicts for processing
        entries = [dict(entry) for entry in cost_basis_entries]
        
        # Group entries by ticker and account
        ticker_groups = {}
        for entry in entries:
            ticker = entry['ticker']
            entry_account_id = entry.get('account_id')
            account_name = entry.get('account_name', 'Unknown')
            
            # If filtering by account_id, only include entries that match
            if account_id and entry_account_id != account_id:
                print(f'[DEBUG] Skipping entry - entry_account_id: {entry_account_id}, filter_account_id: {account_id}')
                continue
            
            # Create a unique key for ticker + account combination
            key = f"{ticker}_{entry_account_id}"
            if key not in ticker_groups:
                ticker_groups[key] = {
                    'trades': [],
                    'account_id': entry_account_id,
                    'account_name': account_name
                }
            ticker_groups[key]['trades'].append(entry)
        
        # Fetch all company names at once for better performance
        unique_tickers = set()
        for key, ticker_data in ticker_groups.items():
            if ticker_data['trades']:
                unique_tickers.add(ticker_data['trades'][0]['ticker'])
        
        # Batch fetch company names
        company_names = {}
        if unique_tickers:
            placeholders = ','.join(['?'] * len(unique_tickers))
            cursor.execute(f'SELECT ticker, company_name FROM tickers WHERE ticker IN ({placeholders})', list(unique_tickers))
            for row in cursor.fetchall():
                ticker_key = row['ticker']
                company_name_val = row['company_name']
                if company_name_val and company_name_val.upper() != ticker_key.upper():
                    company_names[ticker_key] = company_name_val
                else:
                    # Company name is missing or equals ticker - use ticker for now
                    # Don't fetch from yfinance here as it's too slow for multiple tickers
                    # Company names will be fetched in background via /api/pending-tickers endpoint
                    company_names[ticker_key] = ticker_key
        
        result = []
        print(f'[DEBUG] Number of ticker_groups (ticker+account combinations): {len(ticker_groups)}')
        for key, ticker_data in ticker_groups.items():
            ticker = ticker_data['trades'][0]['ticker'] if ticker_data['trades'] else ''
            entries_list = ticker_data['trades']
            print(f'[DEBUG] Processing group {key} - ticker: {ticker}, account_id: {ticker_data.get("account_id")}, account_name: {ticker_data.get("account_name")}, entries: {len(entries_list)}')
            # Sort entries by transaction_date to ensure correct running totals
            entries_list.sort(key=lambda x: (x.get('transaction_date', ''), x.get('id', 0)))
            
            # Get company name from pre-fetched dictionary
            company_name = company_names.get(ticker, ticker)
            
            # Map cost_basis entries and dividends to trade structure
            mapped_trades = []
            # Calculate running totals by summing shares and amounts
            calculated_running_shares = 0
            calculated_running_basis = 0
            for entry in entries_list:
                entry_type = entry.get('entry_type', 'cost_basis')
                
                if entry_type == 'dividend':
                    # Handle dividend entries
                    # For dividends, the SQL query uses 'cf.amount as total_amount'
                    amount = entry.get('total_amount', 0) or 0
                    # Dividends don't affect shares, but they do affect the basis (they're income)
                    # For display purposes, we'll show the dividend amount but keep shares unchanged
                    calculated_running_basis += amount  # Dividends increase basis (they're income)
                    
                    trade = {
                        'id': entry.get('id'),
                        'date_trade_open': entry.get('transaction_date'),
                        'trade_description': entry.get('description', 'Dividend'),
                        'shares': 0,  # Dividends don't affect share count
                        'cost_per_share': 0,
                        'amount': amount,
                        'running_basis': calculated_running_basis,
                        'running_basis_per_share': calculated_running_basis / calculated_running_shares if calculated_running_shares != 0 else calculated_running_basis,
                        'running_shares': calculated_running_shares,  # Shares unchanged
                        'trade_status': None,
                        'trade_type': 'Dividend',
                        'is_dividend': True
                    }
                    mapped_trades.append(trade)
                else:
                    # Handle cost_basis entries (trades)
                    shares = entry.get('shares', 0) or 0
                    amount = entry.get('total_amount', 0) or 0
                    calculated_running_shares += shares
                    calculated_running_basis += amount
                    
                    # Calculate basis per share for this entry
                    basis_per_share = calculated_running_basis / calculated_running_shares if calculated_running_shares != 0 else calculated_running_basis
                    
                    trade = {
                        'id': entry.get('id'),
                        'date_trade_open': entry.get('transaction_date'),
                        'trade_description': entry.get('description'),
                        'shares': shares,
                        'cost_per_share': entry.get('cost_per_share'),
                        'amount': amount,
                        'running_basis': calculated_running_basis,
                        'running_basis_per_share': basis_per_share,
                        'running_shares': calculated_running_shares,
                        'trade_status': entry.get('status'),  # From linked trade
                        'trade_type': entry.get('trade_type'),  # From linked trade
                        'is_dividend': False
                    }
                    mapped_trades.append(trade)
            
            # Calculate totals from the calculated running totals (more reliable than database values)
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
                'account_id': ticker_data.get('account_id'),
                'account_name': ticker_data.get('account_name'),
                'total_shares': total_shares,
                'total_cost_basis': total_cost_basis,
                'total_cost_basis_per_share': total_cost_basis_per_share,
                'trades': mapped_trades
            })
        
        # Sort result based on whether ticker is selected
        if ticker:
            # When ticker is selected: Rule One account (id=9) first
            result.sort(key=lambda x: (
                0 if x.get('account_id') == 9 else 1  # Rule One (id=9) comes first
            ))
        else:
            # When no ticker is selected: Rule One account (id=9) first, then by ticker alphabetically
            result.sort(key=lambda x: (
                0 if x.get('account_id') == 9 else 1,  # Rule One (id=9) comes first
                x.get('ticker', '').upper()  # Then sort by ticker alphabetically
            ))
        
        conn.close()
        return jsonify(result)
    except Exception as e:
        print(f'Error fetching cost basis: {e}')
        return jsonify({'error': 'Failed to fetch cost basis'}), 500

@app.route('/api/summary')
def get_summary():
    try:
        account_id = request.args.get('account_id', type=int)
        ticker = request.args.get('ticker', '')
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
        
        if account_id:
            query += ' AND st.account_id = ?'
            params.append(account_id)
        
        if ticker:
            query += ' AND s.ticker = ?'
            params.append(ticker.upper())
        
        if start_date:
            query += ' AND st.date_trade_open >= ?'
            params.append(start_date)
        
        if end_date:
            query += ' AND st.date_trade_open <= ?'
            params.append(end_date)
        
        cursor.execute(query, params)
        trades = cursor.fetchall()
        
        # Calculate total_net_credit from cash_flows where transaction_type='OPTIONS'
        cash_flow_query = '''
            SELECT SUM(cf.amount) as total_net_credit
            FROM cash_flows cf
            WHERE cf.transaction_type = 'OPTIONS'
        '''
        cash_flow_params = []
        
        if ticker:
            cash_flow_query += '''
                AND cf.trade_id IN (
                    SELECT st.id 
                    FROM trades st 
                    JOIN tickers s ON st.ticker_id = s.id 
                    WHERE s.ticker = ?
                )
            '''
            cash_flow_params.append(ticker.upper())
        
        if account_id:
            cash_flow_query += ' AND cf.account_id = ?'
            cash_flow_params.append(account_id)
        
        if start_date:
            cash_flow_query += ' AND cf.transaction_date >= ?'
            cash_flow_params.append(start_date)
        
        if end_date:
            cash_flow_query += ' AND cf.transaction_date <= ?'
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
            date_trade_open = trade_dict['date_trade_open']
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
                # Options trade: determine if PUT or CALL
                if 'PUT' in trade_type or 'ROP' in trade_type:
                    transaction_type = 'SELL PUT'
                elif 'CALL' in trade_type or 'ROC' in trade_type:
                    transaction_type = 'SELL CALL'
                else:
                    # Default to PREMIUM_CREDIT if can't determine
                    transaction_type = 'PREMIUM_CREDIT'
                amount = premium * num_of_contracts * 100
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (account_id, date_trade_open, transaction_type, round(amount, 2), 
                      f"{trade_type} premium received", trade_id, ticker_id))
            else:
                # Non-options trade: use PREMIUM_CREDIT or PREMIUM_DEBIT
                amount = trade_dict.get('total_premium', premium * num_of_contracts)
                if trade_type == 'BTO':
                    transaction_type = 'PREMIUM_DEBIT'  # Buying stock
                else:
                    transaction_type = 'PREMIUM_CREDIT'  # Selling stock
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (account_id, date_trade_open, transaction_type, round(amount, 2), 
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
                ''', (account_id, date_trade_open, 'ASSIGNMENT', round(assignment_amount, 2), 
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
            date_trade_open = trade_dict['date_trade_open']
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
                # No cash flow found, but still create cost basis entry if it doesn't exist
                if not cost_basis_entry:
                    print(f"No ASSIGNMENT cash flow found for trade {trade_id}, but creating cost basis entry anyway", flush=True)
                    create_assigned_cost_basis_entry(cursor, trade_dict)
                    created_count += 1
        
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

@app.route('/api/backfill-cash-flows-for-cost-basis', methods=['POST'])
def backfill_cash_flows_for_cost_basis():
    """Create missing cash_flow entries for all cost_basis entries that don't have one"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all cost_basis entries without cash_flow_id
        cursor.execute('''
            SELECT cb.*, t.ticker, tr.trade_type, tr.trade_status, tr.num_of_contracts, 
                   tr.strike_price, tr.expiration_date, tr.account_id as trade_account_id
            FROM cost_basis cb
            JOIN tickers t ON cb.ticker_id = t.id
            LEFT JOIN trades tr ON cb.trade_id = tr.id
            WHERE cb.cash_flow_id IS NULL
            ORDER BY cb.transaction_date ASC
        ''')
        cost_basis_entries = cursor.fetchall()
        
        print(f"Found {len(cost_basis_entries)} cost_basis entries without cash_flow_id", flush=True)
        
        created_count = 0
        linked_count = 0
        
        for cb_entry in cost_basis_entries:
            cb_dict = dict(cb_entry)
            cb_id = cb_dict['id']
            account_id = cb_dict['account_id']
            ticker_id = cb_dict['ticker_id']
            trade_id = cb_dict['trade_id']
            transaction_date = cb_dict['transaction_date']
            description = cb_dict['description']
            total_amount = cb_dict['total_amount']
            ticker = cb_dict['ticker']
            
            # Check if a cash_flow already exists for this trade and transaction_date
            cursor.execute('''
                SELECT id FROM cash_flows
                WHERE trade_id = ? AND transaction_date = ? AND ticker_id = ?
            ''', (trade_id, transaction_date, ticker_id))
            existing_cash_flow = cursor.fetchone()
            
            if existing_cash_flow:
                # Link existing cash_flow to cost_basis
                cash_flow_id = existing_cash_flow['id']
                cursor.execute('''
                    UPDATE cost_basis SET cash_flow_id = ? WHERE id = ?
                ''', (cash_flow_id, cb_id))
                linked_count += 1
                print(f"Linked cost_basis {cb_id} to existing cash_flow {cash_flow_id}", flush=True)
            else:
                # Create new cash_flow entry based on cost_basis description
                transaction_type = None
                amount = total_amount
                
                # Determine transaction type based on description
                if 'ASSIGNED' in description.upper() or 'ASSIGNMENT' in description.upper():
                    transaction_type = 'ASSIGNMENT'
                    # For assigned trades, amount should match the cost_basis total_amount
                    # PUT assignments: negative (buying shares)
                    # CALL assignments: positive (selling shares)
                elif 'BTO' in description.upper() or 'BUY' in description.upper():
                    transaction_type = 'PREMIUM_DEBIT'  # Buying stock
                    # BTO: negative amount (buying shares, money goes out)
                    amount = abs(total_amount) if total_amount < 0 else -abs(total_amount)
                elif 'STC' in description.upper() or 'SELL' in description.upper():
                    # Options trades (SELL): determine PUT or CALL
                    # Stock trades (STC): PREMIUM_CREDIT
                    if cb_dict.get('trade_type') and cb_dict['trade_type'] not in ['BTO', 'STC']:
                        # Options trade: determine PUT or CALL
                        trade_type = cb_dict['trade_type']
                        if 'PUT' in trade_type or 'ROP' in trade_type:
                            transaction_type = 'SELL PUT'
                        elif 'CALL' in trade_type or 'ROC' in trade_type:
                            transaction_type = 'SELL CALL'
                        else:
                            transaction_type = 'PREMIUM_CREDIT'
                        # Options: negative amount (we receive premium)
                        amount = abs(total_amount) if total_amount < 0 else -abs(total_amount)
                    else:
                        transaction_type = 'PREMIUM_CREDIT'  # Stock trade
                        # STC: positive amount (selling shares, money comes in)
                        amount = abs(total_amount) if total_amount > 0 else -abs(total_amount)
                else:
                    # Default: assume it's an options trade
                    if cb_dict.get('trade_type'):
                        trade_type = cb_dict['trade_type']
                        if 'PUT' in trade_type or 'ROP' in trade_type:
                            transaction_type = 'SELL PUT'
                        elif 'CALL' in trade_type or 'ROC' in trade_type:
                            transaction_type = 'SELL CALL'
                        else:
                            transaction_type = 'PREMIUM_CREDIT'
                    else:
                        transaction_type = 'PREMIUM_CREDIT'
                    amount = abs(total_amount) if total_amount < 0 else -abs(total_amount)
                
                # Create cash_flow entry
                cash_flow_description = description
                cursor.execute('''
                    INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (account_id, transaction_date, transaction_type, round(amount, 2), 
                      cash_flow_description, trade_id, ticker_id))
                cash_flow_id = cursor.lastrowid
                
                # Link cost_basis to cash_flow
                cursor.execute('''
                    UPDATE cost_basis SET cash_flow_id = ? WHERE id = ?
                ''', (cash_flow_id, cb_id))
                
                created_count += 1
                print(f"Created cash_flow {cash_flow_id} for cost_basis {cb_id} ({description})", flush=True)
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': f'Created {created_count} new cash_flow entries and linked {linked_count} existing entries for {len(cost_basis_entries)} cost_basis entries'
        })
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'Error backfilling cash flows for cost basis: {e}')
        print(f'Traceback: {error_detail}')
        return jsonify({'error': f'Failed to backfill cash flows: {str(e)}'}), 500

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
            
            # Install/update Python packages from requirements.txt
            print("Installing/updating Python packages...")
            install_result = subprocess.run(
                ['pip3', 'install', '--user', '-r', 'requirements.txt'],
                cwd=project_dir,
                capture_output=True,
                text=True
            )
            if install_result.returncode == 0:
                print("✓ Packages installed/updated")
                
                # Clean up temporary files to reduce storage spike
                print("Cleaning up temporary files...")
                try:
                    # Clean pip cache
                    subprocess.run(['pip3', 'cache', 'purge'], 
                                 cwd=project_dir,
                                 capture_output=True,
                                 text=True,
                                 timeout=30)
                    print("✓ Pip cache cleaned")
                except Exception as e:
                    print(f"Warning: Could not clean pip cache: {e}")
                
                try:
                    # Clean git objects (garbage collection)
                    subprocess.run(['git', 'gc', '--prune=now'], 
                                 cwd=project_dir,
                                 capture_output=True,
                                 text=True,
                                 timeout=60)
                    print("✓ Git objects cleaned")
                except Exception as e:
                    print(f"Warning: Could not clean git objects: {e}")
            else:
                print(f"Warning: Package installation had issues: {install_result.stderr}")
            
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
        
        # Get all trades - ORDER BY date_trade_open to process in chronological order
        cursor.execute('''
            SELECT * FROM trades ORDER BY date_trade_open ASC
        ''')
        trades = cursor.fetchall()
        
        # Delete all existing cost basis entries
        cursor.execute('DELETE FROM cost_basis')
        
        # Recreate cost basis entries for each trade
        for trade in trades:
            trade_dict = dict(trade)
            trade_id = trade_dict['id']
            trade_type = trade_dict['trade_type']
            date_trade_open = trade_dict['date_trade_open']
            num_of_contracts = trade_dict['num_of_contracts']
            premium = trade_dict['premium']
            account_id = trade_dict['account_id']
            ticker_id = trade_dict['ticker_id']
            
            if trade_type in ['BTO', 'STC']:
                # For BTO/STC, we need to get the purchase price
                total_amount = premium * num_of_contracts
                create_cost_basis_entry(cursor, account_id, ticker_id, trade_id, date_trade_open, 
                                       trade_type, num_of_contracts, premium, total_amount)
            else:
                # For options trades
                strike_price = trade_dict['strike_price']
                expiration_date = trade_dict['expiration_date']
                create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, date_trade_open, 
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
        
        # Get account_id from request (default to 9 for backward compatibility)
        account_id = request.form.get('account_id', type=int)
        if not account_id:
            account_id = 9  # Default to Rule One account
        
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
                3:  "date_trade_open",      # Row 3 -> trades.date_trade_open  
                5:  "current_price",   # Row 5 -> trades.current_price
                8:  "expiration_date",  # Row 8 -> trades.expiration_date
                15: "strike_price",     # Row 15 -> trades.strike_price (short strike)
                21: "credit_debit",     # Row 21 -> trades.credit_debit
                41: "num_of_contracts", # Row 41 -> trades.num_of_contracts
                64: "trade_status",     # Value from row 65 -> trades.trade_status (dropdown: open, expired, closed, roll, assigned)
                65: "roll_indicator",   # Row 65 -> "ROLL" indicates this column is a roll trade
            }

            # Build trade columns from row 1 (trade_type_raw)
            trade_type_row = rows.get(1, {})
            trade_cols = sorted(trade_type_row.keys())
            
            # Use ALL columns where row 1 has data
            # Trade status: read from row 65 only
            trade_status_row = rows.get(65, {})
            
            def get_trade_status_for_col(col):
                v = trade_status_row.get(col) or ""
                return (v.strip() if isinstance(v, str) else str(v).strip()) if v else ""
            
            print(f"Row 1 has {len(trade_cols)} columns: {trade_cols[:10]}...")
            print(f"Row 65 has {len(trade_status_row)} columns for trade_status", flush=True)
            print(f"Importing all trades from row 1", flush=True)

            # Build a dataframe column by column
            # Only include columns where row 1 has a value (skip empty metadata columns)
            # Row 65 provides trade_status (see get_trade_status_for_col)
            # Row 65 provides roll indicator - if "ROLL", this column is a roll trade
            data = {field: [] for field in mapping.values()}
            data['trade_parent_id'] = []  # Add trade_parent_id to track roll relationships
            data['after_blank'] = []  # Track if this trade comes after a blank column
            collected_cols = []
            
            # Get row 65 for roll indicator
            roll_indicator_row = rows.get(65, {})
            
            # Track the previous trade's column index for roll trades
            previous_trade_col = None
            
            print(f"Processing {len(trade_cols)} potential trade columns from row 1", flush=True)
            trades_found = 0
            for i, c in enumerate(trade_cols):
                # Check if row 1 has data in this column (trade_type_raw)
                if 1 in rows and c in rows[1] and rows[1][c]:
                    trades_found += 1
                    # Check if this trade comes after a blank column
                    # A blank column is detected if:
                    # 1. This is the first trade (previous_trade_col is None), OR
                    # 2. There's a gap between the previous trade column and this column (not adjacent)
                    #    (e.g., previous was column 5, this is column 10 - columns 6-9 are blank)
                    if previous_trade_col is None:
                        after_blank = True
                    else:
                        # Check if there's a gap between previous_trade_col and current column
                        # If the difference is more than 1, there are blank columns in between
                        after_blank = (c - previous_trade_col > 1)
                    
                    # Check if row 65 indicates this is a roll trade
                    roll_indicator = roll_indicator_row.get(c, "").strip().upper() if roll_indicator_row else ""
                    is_roll = roll_indicator == "ROLL"
                    
                    # Import logic:
                    # 1. Blank column = separator, starts a new trade sequence (not linked)
                    # 2. If a trade has status "roll" and comes after a blank column, the next trade (if not blank) should be its child
                    # 3. If a trade is adjacent to a previous trade (not after blank), it should be part of the chain (child of previous)
                    # 4. Chain continues until a blank column is encountered
                    
                    if after_blank:
                        # This trade comes after a blank column - it's a new trade sequence
                        # IMPORTANT: If there's a blank column before a trade, it should NOT have a trade_parent_id
                        # If it's a roll trade, the next trade (if not blank) will be its child
                        trade_parent_id = None  # Will be set during insertion if needed
                        print(f"Column {c}: Trade comes after blank column (gap detected: {c - previous_trade_col if previous_trade_col else 'first trade'}), treating as new trade sequence", flush=True)
                        previous_trade_col = c  # Update previous trade column
                    else:
                        # This trade is adjacent to a previous trade (not after blank)
                        # It should be part of the chain (child of previous)
                        trade_parent_id = None  # Will be set during insertion based on previous_trade_id
                        previous_trade_col = c  # Update previous trade column
                    
                    collected_cols.append(c)
                    for r, field in mapping.items():
                        # For trade_status, use value from row 65
                        if field == "trade_status":
                            val = get_trade_status_for_col(c)
                        elif field == "roll_indicator":
                            val = roll_indicator
                        else:
                            val = rows.get(r, {}).get(c, "")
                        data[field].append(val)
                        # Debug: Check trade_status value for this column
                        if r == 64 and field == "trade_status":
                            status_msg = f"'{val}'" if val else "'EMPTY - will default to open'"
                            print(f"Trade status from column {c} (row 65): {status_msg}", flush=True)
                    
                    # Add trade_parent_id (will be updated during insertion)
                    data['trade_parent_id'].append(trade_parent_id)
                    # Add after_blank flag
                    data['after_blank'].append(after_blank)
                else:
                    # Blank column - reset previous_trade_col to start a new trade sequence
                    previous_trade_col = None
            
            print(f"Found {trades_found} trades with data in row 1", flush=True)
            print(f"Collected {len(collected_cols)} columns for dataframe: {collected_cols[:5]}...", flush=True)
            
            df = pd.DataFrame(data)
            
            if len(collected_cols) == 0:
                print("ERROR: No trade columns found! Row 1 must have data in columns E onward.", flush=True)
                print(f"Row 1 has {len(trade_type_row)} columns: {sorted(trade_type_row.keys())[:10]}...", flush=True)
                return jsonify({
                    'success': False,
                    'error': 'No trade columns found in Excel file. Make sure Row 1 has trade data starting from column E.',
                    'imported': 0,
                    'skipped': 0,
                    'errors': ['No trade columns found in Excel file']
                })
            
            # Debug: Check what row 57 has
            if 57 in rows:
                logging.info(f"Row 57 data (keys): {list(rows[57].keys())[:10]}...")
                # Print first few values from row 57
                for k in list(rows[57].keys())[:10]:
                    logging.info(f"  Column {k}: {rows[57][k]}")
            
            print(f"\nDataframe has {len(df)} rows", flush=True)
            print(f"Dataframe columns: {df.columns.tolist()}", flush=True)
            
            if len(df) == 0:
                print("ERROR: Dataframe is empty after creation! Check Excel file format.", flush=True)
                return jsonify({
                    'success': False,
                    'error': 'No trade data found in Excel file. Dataframe is empty.',
                    'imported': 0,
                    'skipped': 0,
                    'errors': ['Dataframe is empty - no trades to import']
                })
            
            # Check if trade_status column has values
            if 'trade_status' in df.columns:
                print(f"\nTrade status sample values: {df['trade_status'].head(10).tolist()}", flush=True)
                print(f"Trade status unique: {df['trade_status'].unique()}", flush=True)

            # Clean and convert
            def clean_trade_type(label):
                """Strip the ticker symbol from 'SLV ROCT CALL' → 'ROCT CALL'"""
                parts = str(label).split()
                return " ".join(parts[1:]) if len(parts) > 1 else str(label)

            print(f"Before date conversion - date_trade_open sample: {df['date_trade_open'].head(5).tolist()}", flush=True)
            df["date_trade_open"] = pd.to_datetime(df["date_trade_open"], errors="coerce")
            df["expiration_date"] = pd.to_datetime(df["expiration_date"], errors="coerce")
            print(f"After date conversion - date_trade_open sample: {df['date_trade_open'].head(5).tolist()}", flush=True)
            print(f"Date parsing failures - NaT count for date_trade_open: {df['date_trade_open'].isna().sum()}, expiration_date: {df['expiration_date'].isna().sum()}", flush=True)
            
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
            print(f"Extracted tickers sample: {df['ticker'].head(10).tolist()}", flush=True)
            print(f"Extracted trade types from Excel: {df['trade_type'].unique()}", flush=True)
            print(f"Ticker extraction - empty/UNKNOWN count: {(df['ticker'] == '').sum() + (df['ticker'] == 'UNKNOWN').sum()}", flush=True)
            
            # Debug: Check if trade_status column exists and what values it has
            if 'trade_status' in df.columns:
                print("Trade status values in dataframe:", df["trade_status"].unique(), flush=True)
                print(f"Sample trade_status values: {df['trade_status'].head(10).tolist()}", flush=True)
            else:
                print("WARNING: trade_status column NOT found in dataframe!", flush=True)

            for n in ["current_price", "strike_price", "credit_debit", "num_of_contracts"]:
                df[n] = pd.to_numeric(df[n], errors="coerce")

            print(f"Dataframe before dropna: {len(df)} rows", flush=True)
            df = df.dropna(subset=["date_trade_open", "ticker"], how="any")
            print(f"Dataframe after dropna: {len(df)} rows", flush=True)

            # Import all trades
            df_to_insert = df
            print(f"df_to_insert has {len(df_to_insert)} rows to import", flush=True)

            # Insert into database
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Reset trades and cost_basis tables for the selected account only before importing
            # This prevents deleting data from other accounts
            # IMPORTANT: We preserve cost_basis entries that were created from cost basis import
            # by NOT deleting cost_basis entries when importing trades - we only delete trades
            # This way, cost_basis entries from cost basis import remain even if their trades are deleted
            
            # Delete all trades for this account
            # NOTE: We intentionally do NOT delete cost_basis entries here
            # This preserves cost_basis entries that were created from cost basis import
            # even though their associated trades will be deleted
            cursor.execute('DELETE FROM trades WHERE account_id = ?', (account_id,))
            
            conn.commit()
            print(f"Reset trades table for account {account_id} before import (preserving cost_basis entries)", flush=True)
            
            # Check for duplicates against existing trades from the selected account only
            try:
                existing = pd.read_sql("SELECT * FROM trades WHERE account_id = ?", conn, params=(account_id,))
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
                df_to_insert['date_trade_open_str'] = df_to_insert['date_trade_open'].dt.strftime('%Y-%m-%d')
                df_to_insert['expiration_date_str'] = df_to_insert['expiration_date'].dt.strftime('%Y-%m-%d')
                
                # Create comparison columns
                df_to_insert['key'] = (df_to_insert['ticker'] + '|' + 
                                     df_to_insert['date_trade_open_str'] + '|' + 
                                     df_to_insert['expiration_date_str'] + '|' + 
                                     df_to_insert['trade_type'].astype(str) + '|' + 
                                     df_to_insert['num_of_contracts'].astype(str) + '|' + 
                                     df_to_insert['credit_debit'].astype(str))
                
                if 'ticker' in existing.columns:
                    existing['key'] = (existing['ticker'].astype(str) + '|' + 
                                     existing['date_trade_open'].astype(str) + '|' + 
                                     existing['expiration_date'].astype(str) + '|' + 
                                     existing['trade_type'].astype(str) + '|' + 
                                     existing['num_of_contracts'].astype(str) + '|' + 
                                     existing['credit_debit'].astype(str))
                    
                    # Filter out duplicates
                    df_to_insert = df_to_insert[~df_to_insert['key'].isin(existing['key'])]
                
                # Drop helper columns
                df_to_insert = df_to_insert.drop(columns=['key', 'date_trade_open_str', 'expiration_date_str'], errors='ignore')
            
            # Store count before insertion loop
            final_count_before_insert = len(df_to_insert)
            print(f"About to process {final_count_before_insert} trades for import", flush=True)
            imported_count = 0
            errors = []
            
            # Track the previous trade's ID for roll trades
            previous_trade_id = None
            
            for idx, row in df_to_insert.iterrows():
                # Check if this trade comes after a blank column - if so, reset previous_trade_id
                after_blank = row.get('after_blank', False)
                if after_blank:
                    previous_trade_id = None
                    print(f"Row {idx}: Blank column detected, resetting previous_trade_id", flush=True)
                
                try:
                    # Get ticker safely
                    ticker = str(row.get('ticker', '')).strip()
                    if not ticker:
                        errors.append(f"Row {idx}: Missing ticker")
                        continue
                        
                    date_trade_open = row['date_trade_open'].strftime('%Y-%m-%d')
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
                    strike_price = round_standard(float(row['strike_price']) if pd.notna(row['strike_price']) else 0, 2)
                    current_price = float(row['current_price']) if pd.notna(row['current_price']) else 0
                    
                    # Read trade_status from dataframe (sourced from row 65 in Excel)
                    # Normalize for case-insensitive and numeric matching
                    if 'trade_status' in row and pd.notna(row['trade_status']) and str(row['trade_status']).strip():
                        raw_status = row['trade_status']
                        status_val = str(raw_status).strip()
                        # Normalize numeric values (Excel may store 79.0 or 79)
                        try:
                            status_val = str(int(float(status_val)))
                        except (ValueError, TypeError):
                            status_val = status_val.lower()
                        
                        # Debug: print the raw status value
                        print(f"Importing trade_status: raw='{raw_status}', normalized='{status_val}' (ticker: {ticker})", flush=True)
                        
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
                        # No status provided - use open as default
                        print(f"  No trade_status in row for {ticker}, using 'open'", flush=True)
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
                    date_trade_open_obj = datetime.strptime(date_trade_open, '%Y-%m-%d').date()
                    expiration = datetime.strptime(expiration_date, '%Y-%m-%d').date()
                    days_to_expiration = (expiration - date_trade_open_obj).days
                    
                    # Calculate total_premium
                    total_premium = credit_debit * num_of_contracts
                    
                    # Get commission rate in effect at trade date using the same logic as get_commission_rate
                    # This ensures consistency: finds the commission with the latest effective_date <= trade_date
                    # Example: If commissions are effective on 1/10/2020 and 11/15/2025:
                    #   - Trades on or between 1/10/2020 and before 11/15/2025 use the 1/10/2020 commission
                    #   - Trades on or after 11/15/2025 use the 11/15/2025 commission
                    db = get_db_helper()
                    commission = db.get_commission_rate(account_id, date_trade_open)
                    print(f'[DEBUG] Import - Commission calculated for account_id={account_id}, date_trade_open={date_trade_open}: {commission}', flush=True)
                    
                    # Calculate net_credit_per_share = credit_debit - commission_per_share (rounded to 5 decimal places for storage, displayed as 2 decimals)
                    net_credit_per_share = round_standard((credit_debit - commission), 5)
                    
                    # Calculate risk_capital_per_share for ROCT PUT and RULE ONE PUT trades (rounded to nearest hundredth, always rounding 0.5 up)
                    risk_capital_per_share = None
                    if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                        risk_capital_per_share = round_standard((strike_price - net_credit_per_share), 2)
                    
                    # Calculate margin_capital for options trades
                    # Use unrounded risk_capital_per_share for margin_capital calculation
                    margin_capital = None
                    if trade_type not in ['BTO', 'STC'] and strike_price > 0:
                        # For ROCT PUT and RULE ONE PUT trades, use unrounded risk_capital_per_share
                        if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                            # Use unrounded risk_capital_per_share for margin_capital calculation
                            risk_capital_unrounded = strike_price - net_credit_per_share
                            margin_capital = num_of_contracts * 100 * risk_capital_unrounded
                        else:
                            # For other options trades, use the standard calculation
                            margin_capital = (strike_price - net_credit_per_share) * num_of_contracts * 100
                    
                    # Set default margin_percent to 100%
                    margin_percent = 100.0
                    
                    # Calculate ARORC for ROCT PUT and RULE ONE PUT trades
                    # ARORC = (365 / days_to_expiration) * (net_credit_per_share / (risk_capital_per_share * (margin_percent / 100)))
                    # margin_percent is stored as a percentage (100 = 100%), so divide by 100 to get decimal multiplier
                    # Use unrounded risk_capital_per_share for ARORC calculation
                    arorc = None
                    if 'ROCT PUT' in trade_type or 'RULE ONE PUT' in trade_type or ('PUT' in trade_type and ('ROCT' in trade_type or 'RULE ONE' in trade_type)):
                        # Calculate unrounded risk_capital_per_share for ARORC calculation
                        risk_capital_unrounded = strike_price - net_credit_per_share
                        if risk_capital_unrounded > 0 and days_to_expiration > 0 and margin_percent > 0:
                            # margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
                            denominator = risk_capital_unrounded * (margin_percent / 100.0)
                            if denominator > 0:
                                # Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
                                arorc_decimal = (365.0 / days_to_expiration) * (net_credit_per_share / denominator)
                                arorc = round_standard(arorc_decimal * 100.0, 1)
                    
                    # Get trade_type_id from trade_types table
                    # First try the full trade_type as-is
                    cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (trade_type,))
                    trade_type_row = cursor.fetchone()
                    trade_type_id = trade_type_row['id'] if trade_type_row else None
                    
                    # Initialize base_trade_type for later use
                    base_trade_type = trade_type
                    
                    # If not found, try extracting base trade type (remove ticker prefix if present)
                    if trade_type_id is None and ' ' in trade_type:
                        # Check if it starts with a ticker (4-5 uppercase letters followed by space)
                        parts = trade_type.split(' ', 1)
                        if len(parts) == 2 and len(parts[0]) <= 5 and parts[0].isupper():
                            base_trade_type = parts[1]  # Use the part after the ticker
                            cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (base_trade_type,))
                            trade_type_row = cursor.fetchone()
                            trade_type_id = trade_type_row['id'] if trade_type_row else None
                    
                    if trade_type_id is None:
                        print(f"WARNING: trade_type_id not found for trade_type '{trade_type}'", flush=True)
                    
                    # Check if this trade comes after a blank column
                    after_blank = row.get('after_blank', False)
                    
                    # Import logic:
                    # 1. Blank column = separator, starts a new trade sequence (not linked)
                    # 2. If a trade has status "roll" and comes after a blank column, the next trade (if not blank) should be its child
                    # 3. If a trade is adjacent to a previous trade (not after blank), it should be part of the chain (child of previous)
                    # 4. Chain continues until a blank column is encountered
                    
                    if after_blank:
                        # Trade comes after blank column - it's a new trade sequence
                        # IMPORTANT: If there's a blank column before a trade, it should NOT have a trade_parent_id,
                        # regardless of its status (even if it's "roll")
                        # The blank column is a separator - it starts a new trade sequence
                        trade_parent_id = None
                        print(f"Row {idx}: Trade comes after blank column, treating as new trade sequence (NO PARENT) (ticker: {ticker}, date: {date_trade_open}, status: {trade_status})", flush=True)
                    else:
                        # This trade is adjacent to a previous trade (not after blank)
                        # It should be part of the chain (child of previous)
                        if previous_trade_id is None:
                            print(f"WARNING: Trade is adjacent to previous but previous_trade_id is None for ticker {ticker}", flush=True)
                            trade_parent_id = None
                        else:
                            trade_parent_id = previous_trade_id
                            print(f"Row {idx}: Trade is adjacent to previous (part of chain), setting trade_parent_id={previous_trade_id} (ticker: {ticker}, date: {date_trade_open})", flush=True)
                    
                    # Create trade_dict for use in cost basis creation (before insertion)
                    trade_dict = {
                        'id': None,  # Will be set after insertion
                        'account_id': account_id,
                        'ticker_id': ticker_id,
                        'date_trade_open': date_trade_open,
                        'expiration_date': expiration_date,
                        'trade_type': trade_type,
                        'num_of_contracts': num_of_contracts,
                        'strike_price': strike_price
                    }
                    
                    # Insert trade using flexible schema-aware approach
                    # Get actual columns from the trades table (excluding auto-generated ones)
                    cursor.execute("PRAGMA table_info(trades)")
                    table_columns = [col[1] for col in cursor.fetchall()]
                    # Exclude columns that are auto-generated or shouldn't be inserted
                    exclude_columns = {'id', 'created_at'}
                    insert_columns = [col for col in table_columns if col not in exclude_columns]
                    
                    # Build the INSERT statement dynamically
                    columns_str = ', '.join(insert_columns)
                    placeholders_str = ', '.join(['?' for _ in insert_columns])
                    
                    # Prepare values in the same order as columns
                    # Map of column names to values
                    values_map = {
                        'account_id': account_id,
                        'ticker_id': ticker_id,
                        'ticker': ticker,  # Store ticker symbol
                        'date_trade_open': date_trade_open,
                        'expiration_date': expiration_date,
                        'num_of_contracts': num_of_contracts,
                        'num_of_shares': None,  # Will be set if column exists
                        'credit_debit': credit_debit,
                        'total_premium': total_premium,
                        'days_to_expiration': days_to_expiration,
                        'current_price': current_price,
                        'strike_price': strike_price,
                        'trade_status': trade_status,
                        'trade_type': trade_type,
                        'price_per_share': current_price,
                        'total_amount': total_premium,
                        'commission_per_share': commission,
                        'net_credit_per_share': net_credit_per_share,
                        'risk_capital_per_share': risk_capital_per_share,
                        'margin_capital': margin_capital,
                        'margin_percent': margin_percent,
                        'ARORC': arorc,
                        'trade_type_id': trade_type_id,
                        'trade_parent_id': trade_parent_id
                    }
                    
                    # Build values list in the same order as columns
                    values = [values_map.get(col, None) for col in insert_columns]
                    
                    # Execute the dynamic INSERT
                    cursor.execute(f'''
                        INSERT INTO trades ({columns_str})
                        VALUES ({placeholders_str})
                    ''', values)
                    
                    trade_id = cursor.lastrowid
                    
                    # Update trade_dict with the new trade_id
                    trade_dict['id'] = trade_id
                    
                    # Update previous_trade_id for next iteration
                    # Always update to the current trade_id so that consecutive roll trades chain correctly
                    # For example: Trade A (roll) -> Trade B (roll, parent=A) -> Trade C (roll, parent=B)
                    previous_trade_id = trade_id
                    
                    # Create cost basis entry based on trade status
                    if trade_status == 'assigned':
                        # For assigned trades, create assigned cost basis entry and cash flow
                        # First create the assigned cost basis entry
                        # create_assigned_cost_basis_entry accepts dict or Row, so pass trade_dict directly
                        create_assigned_cost_basis_entry(cursor, trade_dict)
                        
                        # Then create cash flow entry for the assignment
                        shares = num_of_contracts * 100
                        if 'PUT' in trade_type or 'ROP' in trade_type:
                            # PUT assignment: negative amount (buying shares)
                            total_amount = -(strike_price * shares)
                            description = f"ASSIGNMENT: BUY {shares} {ticker} @ ${strike_price} (assigned PUT)"
                        else:
                            # CALL assignment: positive amount (selling shares)
                            total_amount = strike_price * shares
                            description = f"ASSIGNMENT: SELL {shares} {ticker} @ ${strike_price} (assigned CALL)"
                        
                        # Use expiration_date + 2 days as transaction_date for assigned trades
                        try:
                            exp_date_obj = datetime.strptime(expiration_date, '%Y-%m-%d')
                            assignment_transaction_date = (exp_date_obj + timedelta(days=2)).strftime('%Y-%m-%d')
                        except:
                            assignment_transaction_date = expiration_date  # Fallback to expiration_date if parsing fails
                        
                        cursor.execute('''
                            INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        ''', (account_id, assignment_transaction_date, 'ASSIGNMENT', round(total_amount, 2), 
                              description, trade_id, ticker_id))
                        cash_flow_id = cursor.lastrowid
                        
                        # Link the cost_basis entry to this cash flow
                        assigned_date_trade_open = expiration_date
                        cursor.execute('''
                            UPDATE cost_basis SET cash_flow_id = ? 
                            WHERE trade_id = ? AND account_id = ? AND ticker_id = ? AND transaction_date = ?
                            AND description LIKE 'ASSIGNED%' AND cash_flow_id IS NULL
                        ''', (cash_flow_id, trade_id, account_id, ticker_id, assigned_date_trade_open))
                    elif is_roll and trade_parent_id:
                        # For roll trades, create roll diagonal cost basis entry
                        # Get the parent trade details
                        cursor.execute('''
                            SELECT expiration_date, strike_price, trade_type, num_of_contracts
                            FROM trades
                            WHERE id = ?
                        ''', (trade_parent_id,))
                        parent_trade = cursor.fetchone()
                        
                        if parent_trade:
                            original_exp_date = parent_trade['expiration_date']
                            original_strike = parent_trade['strike_price']
                            original_trade_type = parent_trade['trade_type']
                            
                            # Only create if we have valid values
                            if strike_price > 0 and credit_debit != 0:
                                create_roll_diagonal_cost_basis_entry(
                                    cursor, trade_id, trade_parent_id, account_id, ticker_id,
                                    date_trade_open, ticker, expiration_date, original_exp_date,
                                    strike_price, original_strike, credit_debit, original_trade_type, num_of_contracts
                                )
                    else:
                        # For regular trades, create standard options cost basis entry
                        create_options_cost_basis_entry(cursor, account_id, ticker_id, trade_id, date_trade_open, trade_type, 
                                                        num_of_contracts, credit_debit, strike_price, expiration_date)
                    
                    # Create cash flow entry for EVERY trade (if not already created for assigned trades)
                    if trade_status != 'assigned':
                        # Check if this trade type requires contracts
                        cursor.execute('SELECT requires_contracts FROM trade_types WHERE type_name = ?', (base_trade_type,))
                        trade_type_row = cursor.fetchone()
                        requires_contracts = trade_type_row['requires_contracts'] if trade_type_row else 0
                        
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
                            cursor.execute('''
                                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            ''', (account_id, date_trade_open, transaction_type, round(credit_debit * num_of_contracts * 100, 2), 
                                  f"{trade_type} premium received", trade_id, ticker_id))
                            cash_flow_id = cursor.lastrowid
                        else:
                            # For BTO/STC or other trade types that don't require contracts
                            # These are stock trades, use PREMIUM_CREDIT or PREMIUM_DEBIT
                            if trade_type == 'BTO':
                                transaction_type = 'PREMIUM_DEBIT'  # Buying stock
                            else:
                                transaction_type = 'PREMIUM_CREDIT'  # Selling stock
                            cursor.execute('''
                                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            ''', (account_id, date_trade_open, transaction_type, round(total_premium, 2), 
                                  f"{trade_type} {num_of_contracts} shares", trade_id, ticker_id))
                            cash_flow_id = cursor.lastrowid
                        
                        # Update cost_basis entry to link to cash_flow if cash flow was created
                        if cash_flow_id:
                            cursor.execute('''
                                UPDATE cost_basis SET cash_flow_id = ? 
                                WHERE trade_id = ? AND ticker_id = ? AND transaction_date = ? AND cash_flow_id IS NULL
                            ''', (cash_flow_id, trade_id, ticker_id, date_trade_open))
                    
                    imported_count += 1
                    
                except Exception as e:
                    ticker_name = str(row.get('ticker', 'Unknown')).strip()
                    error_msg = f"Row {idx} ({ticker_name}): {str(e)}"
                    errors.append(error_msg)
                    print(f"Import Error: {error_msg}", flush=True)  # Print to console
            
            conn.commit()
            conn.close()
            
            skipped_count = final_count_before_insert - imported_count
            
            # If no trades were imported, include diagnostic information
            diagnostic_info = {}
            if imported_count == 0:
                if final_count_before_insert == 0:
                    diagnostic_info = {
                        'diagnostic': 'No trades found to import. Possible causes:',
                        'checks': [
                            'Excel file may be empty or in wrong format',
                            'Row 1 may not have trade data starting from column E',
                            'All dates may have failed to parse (check date format)',
                            'All tickers may be empty or UNKNOWN',
                            'Check server console for detailed debug output'
                        ]
                    }
                else:
                    diagnostic_info = {
                        'diagnostic': f'Found {final_count_before_insert} trades but none were imported. Possible causes:',
                        'checks': [
                            'All trades may have invalid trade_type (not in trade_types table)',
                            'All trades may have missing required fields',
                            'Database errors may have occurred',
                            'Check server console for detailed error messages'
                        ],
                        'trades_found': final_count_before_insert
                    }
            
            result = {
                'success': True,
                'imported': imported_count,
                'skipped': skipped_count,
                'errors': errors
            }
            if diagnostic_info:
                result['diagnostic'] = diagnostic_info
            
            return jsonify(result)
            
        finally:
            # Clean up temporary file
            import os
            os.unlink(excel_path)
        
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        error_type = type(e).__name__
        error_message = str(e) if str(e) else repr(e)
        print(f'Error importing Excel: {error_type}: {error_message}', flush=True)
        print(f'Traceback: {error_detail}', flush=True)
        return jsonify({'success': False, 'error': f'Failed to import Excel: {error_type}: {error_message}'}), 500

@app.route('/api/import-cost-basis-excel', methods=['POST'])
def import_cost_basis_excel():
    """Import cost basis from Excel file - processes multiple rows per sheet and multiple sheets"""
    import zipfile
    import re
    import tempfile
    from xml.etree import ElementTree as ET
    from datetime import datetime
    
    def cell_value(c, shared_strings):
        """Extract cell value from XML element"""
        v = c.find("{*}v")
        if v is None:
            return ""
        if c.attrib.get("t") == "s":
            try:
                idx = int(v.text)
                return shared_strings[idx] if idx < len(shared_strings) else ""
            except (ValueError, IndexError):
                return ""
        return v.text if v.text else ""
    
    def col_num(ref):
        """Convert Excel column reference (A, B, C...) to number (1, 2, 3...)"""
        m = re.match(r"([A-Z]+)", ref)
        if not m:
            return 1
        col = m.group(1)
        n = 0
        for ch in col:
            n = n * 26 + (ord(ch) - 64)
        return n
    
    def parse_date(date_str):
        """Parse date string in various formats"""
        if not date_str or not date_str.strip():
            return None
        date_str = date_str.strip()
        try:
            # Try DD MMM YY format (e.g., "23 DEC 24")
            if ' ' in date_str and len(date_str.split()) == 3:
                parts = date_str.split()
                if len(parts) == 3:
                    day, month_str, year = parts
                    # Try to parse as DD MMM YY
                    try:
                        month_num = datetime.strptime(month_str, '%b').month
                        if len(year) == 2:
                            year = '20' + year
                        return datetime.strptime(f"{year}-{month_num:02d}-{day.zfill(2)}", '%Y-%m-%d')
                    except ValueError:
                        pass
            # Try DD-MMM-YY format (e.g., "08-APR-20")
            if '-' in date_str and len(date_str.split('-')) == 3:
                parts = date_str.split('-')
                if len(parts) == 3:
                    day, month_str, year = parts
                    # Try to parse as DD-MMM-YY
                    try:
                        month_num = datetime.strptime(month_str, '%b').month
                        if len(year) == 2:
                            year = '20' + year
                        return datetime.strptime(f"{year}-{month_num:02d}-{day.zfill(2)}", '%Y-%m-%d')
                    except ValueError:
                        pass
            # Try MM/DD/YYYY or MM/DD/YY format (month/day/year) - primary format for column C
            if '/' in date_str:
                parts = date_str.split('/')
                if len(parts) == 3:
                    month, day, year = parts
                    if len(year) == 2:
                        year = '20' + year
                    try:
                        return datetime.strptime(f"{year}-{month.zfill(2)}-{day.zfill(2)}", '%Y-%m-%d')
                    except ValueError:
                        pass
            # Try YYYY-MM-DD format
            elif '-' in date_str and len(date_str) == 10:
                return datetime.strptime(date_str, '%Y-%m-%d')
        except ValueError:
            pass
        return None
    
    def get_trade_type(description):
        """Extract trade type from description in column B"""
        if not description:
            return None
        desc_upper = description.strip().upper()
        if 'DIVIDEND' in desc_upper:
            return 'DIVIDEND'
        if 'BUY' in desc_upper or desc_upper.startswith('BTO'):
            return 'BUY'
        if 'SELL' in desc_upper or desc_upper.startswith('STC'):
            return 'SELL'
        if desc_upper.startswith('BTO'):
            return 'BTO'
        if desc_upper.startswith('STC'):
            return 'STC'
        return None
    
    def process_trade_row(cursor, db, cells, row, ticker_id, account_id, ticker_symbol):
        """Process a single trade row (BUY/SELL/BTO/STC)"""
        # Column B: description (already checked for trade type)
        description = cells.get((row, 2), "").strip()
        trade_type_str = get_trade_type(description)
        
        if trade_type_str not in ['BUY', 'SELL', 'BTO', 'STC']:
            return None
        
        # Map to standard trade types
        if trade_type_str == 'BUY':
            trade_type = 'BTO'
        elif trade_type_str == 'SELL':
            trade_type = 'STC'
        else:
            trade_type = trade_type_str
        
        # Column C: transaction_date
        transaction_date_str = cells.get((row, 3), "").strip()
        transaction_date_obj = parse_date(transaction_date_str)
        if not transaction_date_obj:
            print(f"Warning: Invalid date in row {row}, column C: '{transaction_date_str}'", flush=True)
            return None
        transaction_date = transaction_date_obj.strftime('%Y-%m-%d')
        
        # Column E: shares (for cost_basis.shares and trades.num_of_shares)
        shares_str = cells.get((row, 5), "").strip()
        if not shares_str:
            print(f"Warning: No shares value in row {row}, column E", flush=True)
            return None
        try:
            shares = int(float(shares_str))
            num_of_shares = shares  # num_of_shares comes from column E
        except (ValueError, TypeError):
            print(f"Warning: Invalid shares value in row {row}, column E: '{shares_str}'", flush=True)
            return None
        
        # Column F: price_per_share (for trades.price_per_share and cost_basis.cost_per_share)
        price_per_share_str = cells.get((row, 6), "").strip()
        if not price_per_share_str:
            print(f"Warning: No price_per_share value in row {row}, column F", flush=True)
            return None
        try:
            price_per_share = float(price_per_share_str)
        except (ValueError, TypeError):
            print(f"Warning: Invalid price_per_share value in row {row}, column F: '{price_per_share_str}'", flush=True)
            return None
        
        # Calculate total_amount = num_of_shares * price_per_share
        total_amount = num_of_shares * price_per_share
        
        # Get trade type ID
        cursor.execute('SELECT id FROM trade_types WHERE type_name = ?', (trade_type,))
        trade_type_row = cursor.fetchone()
        trade_type_id = trade_type_row['id'] if trade_type_row else None
        
        if trade_type_id is None:
            print(f"Warning: Trade type '{trade_type}' not found in trade_types table", flush=True)
            return None
        
        # Set up trade fields
        date_trade_open = transaction_date
        expiration_date = transaction_date
        days_to_expiration = 0
        # For BTO/STC trades, premium = price_per_share (matches add_trade logic)
        premium = price_per_share
        current_price = 0
        strike_price = 0
        total_premium = premium * num_of_shares  # For BTO/STC: total_premium = premium * num_of_contracts
        
        # Get commission rate in effect at trade date using the same logic as get_commission_rate
        # This ensures consistency: finds the commission with the latest effective_date <= trade_date
        # Example: If commissions are effective on 1/10/2020 and 11/15/2025:
        #   - Trades on or between 1/10/2020 and before 11/15/2025 use the 1/10/2020 commission
        #   - Trades on or after 11/15/2025 use the 11/15/2025 commission
        commission = db.get_commission_rate(account_id, date_trade_open)
        print(f'[DEBUG] Cost Basis Import - Commission calculated for account_id={account_id}, date_trade_open={date_trade_open}: {commission}', flush=True)
        
        # Calculate net_credit_per_share for BTO/STC trades
        # This matches the logic in add_trade: net_credit_per_share = premium - commission
        # where premium = price_per_share for BTO/STC trades
        net_credit_per_share = round_standard((premium - commission), 5)
        
        # Insert trade
        cursor.execute('''
            INSERT INTO trades 
            (account_id, ticker_id, ticker, date_trade_open, expiration_date, num_of_contracts, num_of_shares,
             credit_debit, total_premium, days_to_expiration, current_price, strike_price,
             trade_status, trade_type, commission_per_share, price_per_share, total_amount,
             net_credit_per_share, risk_capital_per_share, margin_percent, ARORC, trade_type_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, ticker_symbol, date_trade_open, expiration_date, num_of_shares, num_of_shares,
              premium, total_premium, days_to_expiration, current_price, strike_price,
              'open', trade_type, commission, price_per_share, total_amount,
              net_credit_per_share, 0, 100.0, None, trade_type_id))
        
        trade_id = cursor.lastrowid
        print(f'Inserted trade {trade_id} - Type: {trade_type}, Date: {transaction_date}, Shares: {shares}', flush=True)
        
        # Get current running totals for cost basis
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
        
        # Calculate running totals based on trade type
        if trade_type in ['BTO', 'BUY']:
            new_running_shares = running_shares + shares
        else:  # STC, SELL
            new_running_shares = running_shares - shares
        
        new_running_basis = running_basis + total_amount
        basis_per_share = new_running_basis / new_running_shares if new_running_shares != 0 else 0
        
        # Insert cost basis entry
        cursor.execute('''
            INSERT INTO cost_basis 
            (account_id, ticker_id, trade_id, cash_flow_id, transaction_date, description, shares, cost_per_share, 
             total_amount, running_basis, running_shares, basis_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, ticker_id, trade_id, None, transaction_date, 
              f"{trade_type} {shares} {ticker_symbol}", shares, price_per_share,
              total_amount, new_running_basis, new_running_shares, basis_per_share))
        
        cost_basis_id = cursor.lastrowid
        
        # Create cash flow entry
        transaction_type = 'PREMIUM_DEBIT' if trade_type in ['BTO', 'BUY'] else 'PREMIUM_CREDIT'
        cursor.execute('''
            INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (account_id, transaction_date, transaction_type, round(total_amount, 2), 
              f"{trade_type} {shares} {ticker_symbol}", trade_id, ticker_id))
        
        cash_flow_id = cursor.lastrowid
        
        # Update cost_basis entry to link to cash_flow
        cursor.execute('''
            UPDATE cost_basis SET cash_flow_id = ? 
            WHERE id = ?
        ''', (cash_flow_id, cost_basis_id))
        
        return {'trade_id': trade_id, 'cost_basis_id': cost_basis_id, 'cash_flow_id': cash_flow_id}
    
    def process_dividend_row(cursor, cells, row, ticker_id, account_id, ticker_symbol):
        """Process a dividend row"""
        # Column B: description (should contain "Dividend")
        description = cells.get((row, 2), "").strip()
        print(f"Processing dividend row {row} - Description: '{description}'", flush=True)
        
        # Column C: transaction_date
        transaction_date_str = cells.get((row, 3), "").strip()
        print(f"Row {row} - Date string from column C: '{transaction_date_str}'", flush=True)
        transaction_date_obj = parse_date(transaction_date_str)
        if not transaction_date_obj:
            print(f"Warning: Invalid date in row {row}, column C for dividend: '{transaction_date_str}'", flush=True)
            return None
        transaction_date = transaction_date_obj.strftime('%Y-%m-%d')
        print(f"Row {row} - Parsed date: '{transaction_date}'", flush=True)
        
        # Column G: amount
        amount_str = cells.get((row, 7), "").strip()
        print(f"Row {row} - Amount string from column G: '{amount_str}'", flush=True)
        if not amount_str:
            print(f"Warning: No amount value in row {row}, column G for dividend", flush=True)
            return None
        try:
            amount = float(amount_str)
            print(f"Row {row} - Parsed amount: {amount}", flush=True)
        except (ValueError, TypeError):
            print(f"Warning: Invalid amount value in row {row}, column G: '{amount_str}'", flush=True)
            return None
        
        # Insert cash flow entry for dividend
        try:
            cursor.execute('''
                INSERT INTO cash_flows (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (account_id, transaction_date, 'Dividend', round(amount, 2), 
                  f"Dividend {ticker_symbol}", None, ticker_id))
            
            cash_flow_id = cursor.lastrowid
            print(f'Inserted dividend cash flow {cash_flow_id} - Date: {transaction_date}, Amount: {amount}, Ticker: {ticker_symbol}', flush=True)
            
            return {'cash_flow_id': cash_flow_id}
        except Exception as e:
            print(f"Error inserting dividend cash flow: {e}", flush=True)
            import traceback
            print(f"Traceback: {traceback.format_exc()}", flush=True)
            raise
    
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'No file provided'}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'success': False, 'error': 'No file selected'}), 400
        
        # Get account_id from request (this is the default account for non-Roth sheets)
        # Always use account_id 9 (Rule One) as the default for non-Roth sheets, regardless of what's selected
        # Only sheets with "Roth" in the name should go to the Roth account
        account_id = request.form.get('account_id', type=int)
        if not account_id:
            account_id = 9  # Default to Rule One account
        
        # Force default to account 9 for non-Roth sheets (ignore the selected account in the dropdown)
        # This ensures only sheets with "Roth" in the name go to Roth account
        default_account_id = 9  # Always use Rule One (9) as default for non-Roth sheets
        
        print(f"Cost basis import - Request account_id: {account_id}, Default account_id for non-Roth sheets: {default_account_id}", flush=True)
        
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp_file:
            file.save(tmp_file.name)
            excel_path = tmp_file.name
        
        try:
            # Get database connection
            conn = get_db_connection()
            cursor = conn.cursor()
            db = get_db_helper()
            
            # Read workbook XML
            with zipfile.ZipFile(excel_path, "r") as z:
                # Shared strings for Excel text values
                shared_strings = []
                if "xl/sharedStrings.xml" in z.namelist():
                    shared_xml = ET.parse(z.open("xl/sharedStrings.xml"))
                    shared_strings = [t.text for t in shared_xml.findall(".//{*}t")]
                
                # Find all sheets
                wb = ET.parse(z.open("xl/workbook.xml"))
                sheets = wb.findall(".//{*}sheet")
                if not sheets:
                    raise ValueError("Couldn't find any sheets in the workbook")
                
                total_trades = 0
                total_dividends = 0
                errors = []
                
                # Get Roth account ID
                cursor.execute('SELECT id FROM accounts WHERE UPPER(account_name) LIKE UPPER(?)', ('%Roth%',))
                roth_account_row = cursor.fetchone()
                roth_account_id = roth_account_row['id'] if roth_account_row else None
                # default_account_id is already set above (always 9 for non-Roth sheets)
                
                print(f"Cost basis import - Roth account_id: {roth_account_id}, Default account_id: {default_account_id}", flush=True)
                
                # Process each sheet
                for sheet_idx, sheet in enumerate(sheets, 1):
                    sheet_name = sheet.attrib.get("name", f"Sheet{sheet_idx}")
                    print(f"Processing sheet {sheet_idx}: '{sheet_name}'", flush=True)
                    
                    # Determine account_id based on sheet name (case-insensitive check)
                    sheet_name_upper = sheet_name.upper()
                    sheet_account_id = default_account_id
                    has_roth = roth_account_id and 'ROTH' in sheet_name_upper
                    print(f"Sheet '{sheet_name}': Checking for 'Roth' - sheet_name_upper='{sheet_name_upper}', contains 'ROTH'={has_roth}, roth_account_id={roth_account_id}", flush=True)
                    if has_roth:
                        sheet_account_id = roth_account_id
                        print(f"Sheet '{sheet_name}': Found 'Roth' in sheet name (case-insensitive), using account_id = {sheet_account_id} (Roth account)", flush=True)
                    else:
                        print(f"Sheet '{sheet_name}': No 'Roth' in sheet name, using account_id = {sheet_account_id} (default account)", flush=True)
                    
                    try:
                        sheet_xml = ET.parse(z.open(f"xl/worksheets/sheet{sheet_idx}.xml"))
                        
                        # Collect all cells from the sheet
                        cells = {}
                        for r in sheet_xml.findall(".//{*}row"):
                            idx = int(r.attrib["r"])
                            for c in r.findall("{*}c"):
                                ref = c.attrib.get("r")
                                if not ref:
                                    continue
                                col = col_num(ref)
                                val = cell_value(c, shared_strings)
                                cells[(idx, col)] = val
                        
                        # Get ticker from B1
                        ticker = cells.get((1, 2), "").strip().upper()
                        if not ticker:
                            print(f"Sheet '{sheet_name}': No ticker found in B1, skipping", flush=True)
                            continue
                        
                        print(f"Sheet '{sheet_name}': Ticker = {ticker}", flush=True)
                        # Use the same cursor to get or create ticker to avoid database locking
                        cursor.execute('SELECT id FROM tickers WHERE UPPER(ticker) = UPPER(?)', (ticker,))
                        ticker_row = cursor.fetchone()
                        if ticker_row:
                            ticker_id = ticker_row['id']
                        else:
                            # Create new ticker using the same cursor
                            cursor.execute('INSERT INTO tickers (ticker, company_name) VALUES (?, ?)', (ticker.upper(), ticker))
                            ticker_id = cursor.lastrowid
                        cursor.execute('SELECT ticker FROM tickers WHERE id = ?', (ticker_id,))
                        ticker_result = cursor.fetchone()
                        ticker_symbol = ticker_result['ticker'] if ticker_result else ticker
                        
                        # Start at row 11 and process rows until blank
                        row = 11
                        processed_data = set()  # Track processed data to prevent duplicates (based on content, not row number)
                        print(f"Sheet '{sheet_name}': Starting to process rows from row 11", flush=True)
                        print(f"Sheet '{sheet_name}': Ticker = {ticker}, Ticker ID = {ticker_id}, Account ID = {sheet_account_id}", flush=True)
                        
                        # Check if row 11 has any data
                        row_11_description = cells.get((11, 2), "").strip()
                        print(f"Sheet '{sheet_name}': Row 11, column B value: '{row_11_description}'", flush=True)
                        
                        while True:
                            # Check if row B is blank
                            description = cells.get((row, 2), "").strip()
                            if not description:
                                # Blank row found, move to next sheet
                                print(f"Sheet '{sheet_name}': Blank row found at row {row}, moving to next sheet", flush=True)
                                break
                            
                            print(f"Sheet '{sheet_name}', Row {row}: Found description '{description}' in column B", flush=True)
                            
                            # Check if it's a dividend (case-insensitive, check for DIVIDEND anywhere in description)
                            description_upper = description.upper()
                            print(f"Sheet '{sheet_name}', Row {row}: Checking for dividend - description_upper = '{description_upper}', contains 'DIVIDEND' = {('DIVIDEND' in description_upper)}", flush=True)
                            if 'DIVIDEND' in description_upper:
                                try:
                                    # Get date and amount to create a unique key for duplicate detection
                                    transaction_date_str = cells.get((row, 3), "").strip()
                                    amount_str = cells.get((row, 7), "").strip()
                                    print(f"Sheet '{sheet_name}', Row {row}: Dividend detected - Date (col C): '{transaction_date_str}', Amount (col G): '{amount_str}'", flush=True)
                                    data_key = ('dividend', ticker_id, transaction_date_str, amount_str)
                                    
                                    # Check if we've already processed this exact dividend data in this import session
                                    if data_key in processed_data:
                                        print(f"Sheet '{sheet_name}', Row {row}: Duplicate dividend data detected in import session, skipping", flush=True)
                                        row += 1
                                        continue
                                    
                                    # Check if this dividend already exists in the database
                                    transaction_date_obj = parse_date(transaction_date_str)
                                    if transaction_date_obj:
                                        transaction_date = transaction_date_obj.strftime('%Y-%m-%d')
                                        try:
                                            amount = float(amount_str)
                                            cursor.execute('''
                                                SELECT id FROM cash_flows 
                                                WHERE ticker_id = ? AND account_id = ? 
                                                AND transaction_date = ? AND transaction_type = 'Dividend' 
                                                AND ABS(amount - ?) < 0.01
                                            ''', (ticker_id, sheet_account_id, transaction_date, amount))
                                            existing_dividend = cursor.fetchone()
                                            if existing_dividend:
                                                print(f"Sheet '{sheet_name}', Row {row}: Dividend already exists in database (ID: {existing_dividend['id']}), skipping", flush=True)
                                                processed_data.add(data_key)
                                                row += 1
                                                continue
                                        except (ValueError, TypeError):
                                            pass  # Will be caught by process_dividend_row
                                    
                                    print(f"Sheet '{sheet_name}', Row {row}: Processing dividend - Description: '{description}', Ticker: {ticker_symbol} (ID: {ticker_id}), Account: {sheet_account_id}", flush=True)
                                    result = process_dividend_row(cursor, cells, row, ticker_id, sheet_account_id, ticker_symbol)
                                    if result:
                                        total_dividends += 1
                                        processed_data.add(data_key)
                                        print(f"Sheet '{sheet_name}', Row {row}: Successfully imported dividend - Cash Flow ID: {result.get('cash_flow_id')}", flush=True)
                                    else:
                                        print(f"Sheet '{sheet_name}', Row {row}: Dividend processing returned None - check date/amount parsing", flush=True)
                                except Exception as e:
                                    error_msg = f"Sheet '{sheet_name}', Row {row}: {str(e)}"
                                    errors.append(error_msg)
                                    print(f"ERROR processing dividend: {error_msg}", flush=True)
                                    import traceback
                                    print(f"Traceback: {traceback.format_exc()}", flush=True)
                                row += 1
                                continue
                            
                            # Check if it's a trade type (BUY, SELL, BTO, STC)
                            trade_type_str = get_trade_type(description)
                            print(f"Sheet '{sheet_name}', Row {row}: get_trade_type returned '{trade_type_str}' for description '{description}'", flush=True)
                            if trade_type_str in ['BUY', 'SELL', 'BTO', 'STC']:
                                try:
                                    # Map to standard trade types (BUY -> BTO, SELL -> STC)
                                    if trade_type_str == 'BUY':
                                        trade_type = 'BTO'
                                    elif trade_type_str == 'SELL':
                                        trade_type = 'STC'
                                    else:
                                        trade_type = trade_type_str
                                    
                                    # Get date and shares to create a unique key for duplicate detection
                                    transaction_date_str = cells.get((row, 3), "").strip()
                                    shares_str = cells.get((row, 5), "").strip()
                                    print(f"Sheet '{sheet_name}', Row {row}: Date='{transaction_date_str}' (col C), Shares='{shares_str}' (col E)", flush=True)
                                    # Create key based on data content, not row number
                                    data_key = ('trade', ticker_id, description, transaction_date_str, shares_str)
                                    
                                    # Check if we've already processed this exact trade data in this import session
                                    if data_key in processed_data:
                                        print(f"Sheet '{sheet_name}', Row {row}: Duplicate trade data detected in import session (Description: '{description}', Date: '{transaction_date_str}', Shares: '{shares_str}'), skipping", flush=True)
                                        row += 1
                                        continue
                                    
                                    # Check if this trade already exists in the database
                                    transaction_date_obj = parse_date(transaction_date_str)
                                    if not transaction_date_obj:
                                        print(f"Sheet '{sheet_name}', Row {row}: Invalid date, skipping duplicate check", flush=True)
                                        row += 1
                                        continue
                                    
                                    transaction_date = transaction_date_obj.strftime('%Y-%m-%d')
                                    try:
                                        shares = int(float(shares_str))
                                    except (ValueError, TypeError) as e:
                                        print(f"Sheet '{sheet_name}', Row {row}: Invalid shares value for duplicate check: {e}, skipping", flush=True)
                                        row += 1
                                        continue
                                    
                                    # The description in the database is formatted as "{trade_type} {shares} {ticker_symbol}"
                                    # Use the mapped trade_type (BTO/STC), not the raw trade_type_str (BUY/SELL)
                                    expected_description = f"{trade_type} {shares} {ticker_symbol}"
                                    print(f"Sheet '{sheet_name}', Row {row}: Checking for duplicate - ticker_id={ticker_id}, account_id={sheet_account_id}, date={transaction_date}, description='{expected_description}', shares={shares}", flush=True)
                                    
                                    # Check for existing trade with exact match
                                    cursor.execute('''
                                        SELECT id, description FROM cost_basis 
                                        WHERE ticker_id = ? AND account_id = ? 
                                        AND transaction_date = ? AND shares = ?
                                    ''', (ticker_id, sheet_account_id, transaction_date, shares))
                                    existing_trades = cursor.fetchall()
                                    
                                    # Check if any existing trade matches the description
                                    found_duplicate = False
                                    for existing in existing_trades:
                                        existing_desc = existing['description']
                                        if existing_desc == expected_description:
                                            found_duplicate = True
                                            print(f"Sheet '{sheet_name}', Row {row}: Trade already exists in database (ID: {existing['id']}, description='{existing_desc}'), skipping", flush=True)
                                            processed_data.add(data_key)
                                            break
                                    
                                    if found_duplicate:
                                        row += 1
                                        continue
                                    
                                    if existing_trades:
                                        print(f"Sheet '{sheet_name}', Row {row}: Found {len(existing_trades)} existing trades with same date/shares but different description. Existing: {[e['description'] for e in existing_trades]}, Expected: '{expected_description}'", flush=True)
                                    else:
                                        print(f"Sheet '{sheet_name}', Row {row}: No duplicate found, proceeding with import", flush=True)
                                    
                                    print(f"Sheet '{sheet_name}', Row {row}: Processing trade - Type: {trade_type}, Ticker: {ticker_symbol}, Account: {sheet_account_id}", flush=True)
                                    result = process_trade_row(cursor, db, cells, row, ticker_id, sheet_account_id, ticker_symbol)
                                    if result:
                                        total_trades += 1
                                        processed_data.add(data_key)
                                        print(f"Sheet '{sheet_name}', Row {row}: Successfully imported trade", flush=True)
                                    else:
                                        print(f"Sheet '{sheet_name}', Row {row}: process_trade_row returned None", flush=True)
                                except Exception as e:
                                    error_msg = f"Sheet '{sheet_name}', Row {row}: {str(e)}"
                                    errors.append(error_msg)
                                    print(f"Error processing trade: {error_msg}", flush=True)
                                    import traceback
                                    print(f"Traceback: {traceback.format_exc()}", flush=True)
                                row += 1
                            else:
                                # Not a trade type, move to next row
                                print(f"Sheet '{sheet_name}', Row {row}: Not a recognized trade type (got '{trade_type_str}'), moving to next row", flush=True)
                                row += 1
                    
                    except Exception as e:
                        error_msg = f"Sheet '{sheet_name}': {str(e)}"
                        errors.append(error_msg)
                        print(f"Error processing sheet: {error_msg}", flush=True)
                        continue
                
                # Commit all changes
                conn.commit()
                conn.close()
                
                message = f'Successfully imported {total_trades} trades and {total_dividends} dividends'
                if errors:
                    message += f'. {len(errors)} errors occurred.'
                
                return jsonify({
                    'success': True,
                    'message': message,
                    'trades_imported': total_trades,
                    'dividends_imported': total_dividends,
                    'errors': errors if errors else []
                })
        
        finally:
            # Clean up temporary file
            import os
            if os.path.exists(excel_path):
                os.unlink(excel_path)
    
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'Error importing cost basis: {e}', flush=True)
        print(f'Traceback: {error_detail}', flush=True)
        error_msg = str(e) if str(e) else 'Unknown error occurred'
        return jsonify({'success': False, 'error': f'Failed to import cost basis: {error_msg}'}), 500

@app.route('/api/import-dividends', methods=['POST'])
def import_dividends():
    """
    Automatically fetch and import dividend payouts from Yahoo Finance.
    
    Request body (optional):
    {
        "tickers": ["AAPL", "MSFT"],  # Optional: specific tickers to import. If not provided, imports for all tickers with trades
        "start_date": "2024-01-01",  # Optional: start date for dividend history (default: 1 year ago)
        "end_date": "2024-12-31",     # Optional: end date for dividend history (default: today)
        "account_id": 9,              # Optional: account_id to use for dividends (default: uses account from trades)
        "dry_run": false              # Optional: if true, only returns what would be imported without creating entries
    }
    """
    try:
        import yfinance as yf
        from datetime import datetime, timedelta
        
        data = request.get_json() or {}
        tickers_to_import = data.get('tickers')  # Optional list of specific tickers
        start_date_str = data.get('start_date')
        end_date_str = data.get('end_date')
        default_account_id = data.get('account_id')
        dry_run = data.get('dry_run', False)
        
        # Parse dates
        if start_date_str:
            start_date = datetime.strptime(start_date_str, '%Y-%m-%d').date()
        else:
            start_date = (datetime.now() - timedelta(days=365)).date()  # Default: 1 year ago
        
        if end_date_str:
            end_date = datetime.strptime(end_date_str, '%Y-%m-%d').date()
        else:
            end_date = datetime.now().date()  # Default: today
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all unique tickers that have trades
        if tickers_to_import:
            # Import specific tickers
            ticker_list = [t.upper() for t in tickers_to_import]
            placeholders = ','.join(['?' for _ in ticker_list])
            cursor.execute(f'''
                SELECT DISTINCT t.id, t.ticker, t.company_name
                FROM tickers t
                JOIN trades tr ON t.id = tr.ticker_id
                WHERE UPPER(t.ticker) IN ({placeholders})
            ''', ticker_list)
        else:
            # Get all tickers that have trades
            cursor.execute('''
                SELECT DISTINCT t.id, t.ticker, t.company_name
                FROM tickers t
                JOIN trades tr ON t.id = tr.ticker_id
                WHERE t.ticker IS NOT NULL AND t.ticker != ""
                ORDER BY t.ticker
            ''')
        
        ticker_rows = cursor.fetchall()
        
        if not ticker_rows:
            conn.close()
            return jsonify({
                'success': True,
                'message': 'No tickers found to import dividends for',
                'imported': 0,
                'skipped': 0,
                'errors': []
            })
        
        imported_count = 0
        skipped_count = 0
        errors = []
        dividend_entries = []
        
        for ticker_row in ticker_rows:
            ticker_id = ticker_row['id']
            ticker_symbol = ticker_row['ticker']
            company_name = ticker_row.get('company_name', ticker_symbol)
            
            try:
                # Fetch dividend history from Yahoo Finance
                print(f'[DIVIDEND IMPORT] Fetching dividends for {ticker_symbol}...', flush=True)
                stock = yf.Ticker(ticker_symbol)
                dividend_history = stock.dividends
                
                if dividend_history.empty:
                    print(f'[DIVIDEND IMPORT] No dividends found for {ticker_symbol}', flush=True)
                    continue
                
                # Filter dividends by date range
                # Convert index to date for comparison
                dividend_history = dividend_history[
                    (dividend_history.index >= pd.Timestamp(start_date)) & 
                    (dividend_history.index <= pd.Timestamp(end_date))
                ]
                
                if dividend_history.empty:
                    print(f'[DIVIDEND IMPORT] No dividends in date range for {ticker_symbol}', flush=True)
                    continue
                
                # Get account_id for this ticker (use account from most recent trade, or default)
                if default_account_id:
                    account_id = default_account_id
                else:
                    cursor.execute('''
                        SELECT account_id FROM trades 
                        WHERE ticker_id = ? 
                        ORDER BY date_trade_open DESC 
                        LIMIT 1
                    ''', (ticker_id,))
                    account_row = cursor.fetchone()
                    account_id = account_row['account_id'] if account_row else 9
                
                # Process each dividend
                for dividend_date, dividend_amount in dividend_history.items():
                    # Handle pandas Timestamp
                    if hasattr(dividend_date, 'strftime'):
                        dividend_date_str = dividend_date.strftime('%Y-%m-%d')
                    elif hasattr(dividend_date, 'date'):
                        dividend_date_str = dividend_date.date().strftime('%Y-%m-%d')
                    else:
                        dividend_date_str = str(dividend_date)
                    
                    # Check if this dividend already exists
                    cursor.execute('''
                        SELECT id FROM cash_flows
                        WHERE ticker_id = ? 
                        AND transaction_type = 'Dividend'
                        AND transaction_date = ?
                        AND ABS(amount - ?) < 0.01
                    ''', (ticker_id, dividend_date_str, float(dividend_amount)))
                    
                    existing = cursor.fetchone()
                    if existing:
                        print(f'[DIVIDEND IMPORT] Skipping duplicate dividend: {ticker_symbol} on {dividend_date_str}', flush=True)
                        skipped_count += 1
                        continue
                    
                    # Create dividend entry
                    description = f"Dividend {ticker_symbol}"
                    amount = float(dividend_amount)
                    
                    if dry_run:
                        dividend_entries.append({
                            'ticker': ticker_symbol,
                            'date': dividend_date_str,
                            'amount': amount,
                            'account_id': account_id,
                            'description': description
                        })
                        imported_count += 1
                    else:
                        cursor.execute('''
                            INSERT INTO cash_flows 
                            (account_id, transaction_date, transaction_type, amount, description, trade_id, ticker_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        ''', (account_id, dividend_date_str, 'Dividend', round(amount, 2), 
                              description, None, ticker_id))
                        imported_count += 1
                        print(f'[DIVIDEND IMPORT] Imported dividend: {ticker_symbol} on {dividend_date_str} - ${amount:.2f}', flush=True)
                
            except Exception as e:
                error_msg = f"Error importing dividends for {ticker_symbol}: {str(e)}"
                print(f'[DIVIDEND IMPORT] {error_msg}', flush=True)
                errors.append(error_msg)
                import traceback
                print(f'[DIVIDEND IMPORT] Traceback: {traceback.format_exc()}', flush=True)
                continue
        
        if not dry_run:
            conn.commit()
        
        conn.close()
        
        result = {
            'success': True,
            'message': f'Imported {imported_count} dividend(s), skipped {skipped_count} duplicate(s)',
            'imported': imported_count,
            'skipped': skipped_count,
            'errors': errors
        }
        
        if dry_run:
            result['dividend_entries'] = dividend_entries
            result['message'] = f'Dry run: Would import {imported_count} dividend(s), skip {skipped_count} duplicate(s)'
        
        return jsonify(result)
        
    except ImportError:
        return jsonify({
            'success': False,
            'error': 'yfinance library not installed. Please install it with: pip install yfinance==0.2.32'
        }), 500
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'[DIVIDEND IMPORT] Error: {e}', flush=True)
        print(f'[DIVIDEND IMPORT] Traceback: {error_detail}', flush=True)
        return jsonify({
            'success': False,
            'error': f'Failed to import dividends: {str(e)}'
        }), 500

# ============================================================================
# SCHWAB API ENDPOINTS
# ============================================================================

try:
    from schwab_api import SchwabAPIClient
    schwab_client = SchwabAPIClient()
    SCHWAB_API_AVAILABLE = True
except Exception as e:
    print(f'[SCHWAB API] Not available: {e}', flush=True)
    schwab_client = None
    SCHWAB_API_AVAILABLE = False

@app.route('/api/schwab/status', methods=['GET'])
def schwab_status():
    """Check Schwab API connection status"""
    if not SCHWAB_API_AVAILABLE:
        return jsonify({
            'available': False,
            'authenticated': False,
            'message': 'Schwab API library not installed. Install with: pip install schwab-py'
        })
    
    # Check if credentials are configured
    app_key = os.getenv('SCHWAB_APP_KEY')
    app_secret = os.getenv('SCHWAB_APP_SECRET')
    
    if not app_key or not app_secret:
        return jsonify({
            'available': True,
            'authenticated': False,
            'message': 'Schwab API credentials not configured. Please set SCHWAB_APP_KEY and SCHWAB_APP_SECRET in .env file.'
        })
    
    if not schwab_client:
        return jsonify({
            'available': True,
            'authenticated': False,
            'message': 'Schwab API client not initialized. Try authenticating.'
        })
    
    # Check if client is actually authenticated by trying a simple operation
    is_auth = schwab_client.is_authenticated()
    
    return jsonify({
        'available': True,
        'authenticated': is_auth,
        'message': 'Authenticated' if is_auth else 'Not authenticated. Click "Authenticate" to connect.'
    })

@app.route('/api/schwab/authenticate', methods=['POST'])
def schwab_authenticate():
    """Trigger Schwab API authentication"""
    if not SCHWAB_API_AVAILABLE:
        return jsonify({
            'success': False,
            'error': 'Schwab API library not installed'
        }), 500
    
    try:
        # Re-initialize the client to trigger authentication
        from schwab_api import SchwabAPIClient
        global schwab_client
        
        # Create a new client instance which will trigger easy_client
        new_client = SchwabAPIClient()
        
        # Try to authenticate
        result = new_client.authenticate()
        
        if result['success']:
            # Update global client
            schwab_client = new_client
            return jsonify({
                'success': True,
                'authenticated': True,
                'message': 'Authentication successful! You can now sync trades.'
            })
        elif result.get('auth_url'):
            # Need manual authentication - return the URL
            return jsonify({
                'success': False,
                'authenticated': False,
                'auth_url': result['auth_url'],
                'message': 'Please visit the authorization URL to authenticate'
            })
        else:
            return jsonify({
                'success': False,
                'authenticated': False,
                'message': result.get('message', 'Authentication failed. Please check your credentials and try again.')
            }), 401
            
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'[SCHWAB AUTH] Error: {e}', flush=True)
        print(f'[SCHWAB AUTH] Traceback: {error_detail}', flush=True)
        return jsonify({
            'success': False,
            'error': f'Authentication error: {str(e)}',
            'message': 'Please ensure your Schwab API credentials are correct in .env file. If tokens exist, try deleting schwab_tokens.json and re-authenticating.'
        }), 500

@app.route('/api/schwab/auth-url', methods=['GET'])
def schwab_get_auth_url():
    """Get the OAuth authorization URL"""
    if not SCHWAB_API_AVAILABLE:
        return jsonify({
            'success': False,
            'error': 'Schwab API library not installed'
        }), 500
    
    try:
        from schwab_api import SchwabAPIClient
        client = SchwabAPIClient()
        auth_url = client.get_authorization_url()
        
        return jsonify({
            'success': True,
            'auth_url': auth_url
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/auth/schwab/callback', methods=['GET'])
def schwab_oauth_callback():
    """Handle OAuth callback from Schwab"""
    authorization_code = request.args.get('code')
    error = request.args.get('error')
    
    if error:
        return f'<html><body><h1>Authentication Error</h1><p>{error}</p><p><a href="/">Return to app</a></p></body></html>', 400
    
    if not authorization_code:
        return '<html><body><h1>Authentication Error</h1><p>No authorization code received</p><p><a href="/">Return to app</a></p></body></html>', 400
    
    try:
        from schwab_api import SchwabAPIClient
        global schwab_client
        
        client = SchwabAPIClient()
        result = client.authenticate_with_code(authorization_code)
        
        if result['success']:
            schwab_client = client
            return '<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to the app.</p><p><a href="/">Return to app</a></p><script>setTimeout(function(){ window.close(); }, 3000);</script></body></html>'
        else:
            return f'<html><body><h1>Authentication Failed</h1><p>{result.get("message", "Unknown error")}</p><p><a href="/">Return to app</a></p></body></html>', 500
            
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'[SCHWAB CALLBACK] Error: {e}', flush=True)
        print(f'[SCHWAB CALLBACK] Traceback: {error_detail}', flush=True)
        return f'<html><body><h1>Authentication Error</h1><p>{str(e)}</p><p><a href="/">Return to app</a></p></body></html>', 500

@app.route('/api/schwab/accounts', methods=['GET'])
def schwab_get_accounts():
    """Get all Schwab accounts"""
    if not SCHWAB_API_AVAILABLE or not schwab_client:
        return jsonify({'success': False, 'error': 'Schwab API not available'}), 500
    
    try:
        accounts = schwab_client.get_accounts()
        return jsonify({'success': True, 'accounts': accounts})
    except Exception as e:
        print(f'[SCHWAB API] Error fetching accounts: {e}', flush=True)
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/schwab/positions', methods=['GET'])
def schwab_get_positions():
    """Get positions from Schwab accounts"""
    if not SCHWAB_API_AVAILABLE or not schwab_client:
        return jsonify({'success': False, 'error': 'Schwab API not available'}), 500
    
    try:
        account_number = request.args.get('account_number')
        positions = schwab_client.get_positions(account_number)
        return jsonify({'success': True, 'positions': positions})
    except Exception as e:
        print(f'[SCHWAB API] Error fetching positions: {e}', flush=True)
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/schwab/orders', methods=['GET'])
def schwab_get_orders():
    """Get orders (trades) from Schwab accounts"""
    if not SCHWAB_API_AVAILABLE or not schwab_client:
        return jsonify({'success': False, 'error': 'Schwab API not available'}), 500
    
    try:
        account_number = request.args.get('account_number')
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        
        start_date = None
        end_date = None
        
        if start_date_str:
            start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
        if end_date_str:
            end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
        
        orders = schwab_client.get_orders(account_number, start_date, end_date)
        return jsonify({'success': True, 'orders': orders, 'count': len(orders)})
    except Exception as e:
        print(f'[SCHWAB API] Error fetching orders: {e}', flush=True)
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/schwab/quotes', methods=['GET'])
def schwab_get_quotes():
    """Get real-time quotes for symbols"""
    if not SCHWAB_API_AVAILABLE or not schwab_client:
        return jsonify({'success': False, 'error': 'Schwab API not available'}), 500
    
    try:
        symbols_str = request.args.get('symbols', '')
        if not symbols_str:
            return jsonify({'success': False, 'error': 'symbols parameter required'}), 400
        
        symbols = [s.strip().upper() for s in symbols_str.split(',')]
        quotes = schwab_client.get_quotes(symbols)
        return jsonify({'success': True, 'quotes': quotes})
    except Exception as e:
        print(f'[SCHWAB API] Error fetching quotes: {e}', flush=True)
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/schwab/historical', methods=['GET'])
def schwab_get_historical():
    """Get historical price data for a symbol"""
    if not SCHWAB_API_AVAILABLE or not schwab_client:
        return jsonify({'success': False, 'error': 'Schwab API not available'}), 500
    
    try:
        symbol = request.args.get('symbol', '').upper()
        if not symbol:
            return jsonify({'success': False, 'error': 'symbol parameter required'}), 400
        
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        
        if not start_date_str or not end_date_str:
            return jsonify({'success': False, 'error': 'start_date and end_date parameters required'}), 400
        
        start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
        end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
        
        period_type = request.args.get('period_type', 'day')
        frequency_type = request.args.get('frequency_type', 'daily')
        frequency = int(request.args.get('frequency', 1))
        
        data = schwab_client.get_historical_data(
            symbol, start_date, end_date, period_type, frequency_type, frequency
        )
        
        # Convert datetime objects to strings for JSON serialization
        for item in data:
            if isinstance(item['datetime'], datetime):
                item['datetime'] = item['datetime'].isoformat()
        
        return jsonify({'success': True, 'data': data, 'symbol': symbol})
    except Exception as e:
        print(f'[SCHWAB API] Error fetching historical data: {e}', flush=True)
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/schwab/sync-trades', methods=['POST'])
def schwab_sync_trades():
    """Sync trades from Schwab API to local database"""
    if not SCHWAB_API_AVAILABLE or not schwab_client:
        return jsonify({'success': False, 'error': 'Schwab API not available'}), 500
    
    try:
        data = request.get_json() or {}
        account_number = data.get('account_number')
        start_date_str = data.get('start_date')
        end_date_str = data.get('end_date')
        
        start_date = None
        end_date = None
        
        if start_date_str:
            start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
        if end_date_str:
            end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
        
        # Get orders from Schwab
        orders = schwab_client.get_orders(account_number, start_date, end_date)
        
        # Import orders into database
        conn = get_db_connection()
        cursor = conn.cursor()
        
        imported_count = 0
        skipped_count = 0
        errors = []
        
        for order in orders:
            try:
                # Check if order already exists
                cursor.execute('SELECT id FROM trades WHERE schwab_order_id = ?', (order.get('order_id'),))
                if cursor.fetchone():
                    skipped_count += 1
                    continue
                
                # Map Schwab order to trade format
                symbol = order.get('symbol', '')
                if not symbol:
                    continue
                
                # Get or create ticker
                db = get_db_helper()
                ticker_id = db.create_or_get_ticker(symbol, symbol)
                
                # Parse order date
                entered_time = order.get('entered_time', '')
                if entered_time:
                    try:
                        # Parse ISO format datetime
                        order_date = datetime.fromisoformat(entered_time.replace('Z', '+00:00'))
                        date_trade_open = order_date.strftime('%Y-%m-%d')
                    except:
                        date_trade_open = datetime.now().strftime('%Y-%m-%d')
                else:
                    date_trade_open = datetime.now().strftime('%Y-%m-%d')
                
                # Determine trade type
                trade_type = order.get('trade_type', 'STOCK')
                if trade_type == 'OPTION':
                    option_type = order.get('option_type', '')
                    if option_type == 'PUT':
                        trade_type = 'ROCT PUT'
                    elif option_type == 'CALL':
                        trade_type = 'ROCT CALL'
                
                # Get account_id (you may need to map Schwab account to local account)
                account_id = data.get('account_id', 9)  # Default account
                
                # Insert trade
                cursor.execute('''
                    INSERT INTO trades (
                        ticker_id, account_id, date_trade_open, trade_date,
                        expiration_date, current_price, strike_price, credit_debit,
                        num_of_contracts, trade_type, trade_status, schwab_order_id,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ''', (
                    ticker_id, account_id, date_trade_open, date_trade_open,
                    order.get('expiration_date'), order.get('price', 0),
                    order.get('strike_price'), order.get('price', 0),
                    order.get('quantity', 1), trade_type, 'open',
                    order.get('order_id')
                ))
                
                imported_count += 1
                
            except Exception as e:
                errors.append(f"Error importing order {order.get('order_id')}: {str(e)}")
                print(f'[SCHWAB SYNC] Error importing order: {e}', flush=True)
                continue
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'imported': imported_count,
            'skipped': skipped_count,
            'errors': errors,
            'message': f'Imported {imported_count} trade(s), skipped {skipped_count} duplicate(s)'
        })
        
    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f'[SCHWAB SYNC] Error: {e}', flush=True)
        print(f'[SCHWAB SYNC] Traceback: {error_detail}', flush=True)
        return jsonify({
            'success': False,
            'error': f'Failed to sync trades: {str(e)}'
        }), 500

if __name__ == '__main__':
    # Run migrations first to ensure schema is up to date
    try:
        run_migrations()
    except Exception as e:
        print(f"Migration error: {e}")
        print("Falling back to init_db() for initial setup...")
        init_db()
    
    app.run(debug=True, port=5005)
