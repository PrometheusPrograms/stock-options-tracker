"""
Shared test fixtures for the stock options tracker tests
"""
import pytest
import tempfile
import os
import sqlite3
from app import app, init_db, get_db_connection

@pytest.fixture
def client():
    """Create a test client for the Flask app"""
    # Create a temporary database
    db_fd, app.config['DATABASE'] = tempfile.mkstemp(suffix='.db')
    app.config['TESTING'] = True
    app.config['WTF_CSRF_ENABLED'] = False
    
    with app.test_client() as client:
        with app.app_context():
            init_db()
        yield client
    
    # Cleanup
    os.close(db_fd)
    os.unlink(app.config['DATABASE'])

@pytest.fixture
def test_db():
    """Create a test database connection"""
    db_fd, db_path = tempfile.mkstemp(suffix='.db')
    
    # Initialize the test database
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Create all tables (simplified version of init_db)
    cursor.execute('''
        CREATE TABLE accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_name TEXT UNIQUE NOT NULL,
            account_type TEXT DEFAULT 'PRIMARY',
            start_date TEXT,
            starting_balance REAL DEFAULT 0.0
        )
    ''')
    
    cursor.execute('''
        INSERT INTO accounts (account_name, account_type) 
        VALUES ('Test Account', 'INVESTMENT')
    ''')
    
    cursor.execute('''
        CREATE TABLE tickers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT UNIQUE NOT NULL,
            company_name TEXT NOT NULL
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE trades (
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
            margin_capital REAL
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE cost_basis (
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
            basis_per_share REAL NOT NULL
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE cash_flows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_type TEXT NOT NULL,
            amount NUMERIC(12,2) NOT NULL,
            description TEXT,
            trade_id INTEGER,
            ticker_id INTEGER
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE commissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            commission_rate REAL NOT NULL,
            effective_date TEXT NOT NULL,
            notes TEXT
        )
    ''')
    
    conn.commit()
    conn.close()
    
    yield db_path
    
    # Cleanup
    os.close(db_fd)
    if os.path.exists(db_path):
        os.unlink(db_path)

@pytest.fixture
def sample_ticker(test_db):
    """Add a sample ticker to the test database"""
    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    cursor.execute('INSERT INTO tickers (ticker, company_name) VALUES (?, ?)', 
                   ('TSLA', 'Tesla Inc'))
    ticker_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return ticker_id

@pytest.fixture
def sample_trade(test_db, sample_ticker):
    """Add a sample trade to the test database"""
    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    
    cursor.execute('''
        INSERT INTO trades 
        (account_id, ticker_id, trade_date, expiration_date, num_of_contracts,
         premium, total_premium, days_to_expiration, current_price, strike_price,
         status, trade_type, commission, margin_capital)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (9, sample_ticker, '2025-01-15', '2025-01-20', 1, 2.50, 250.00, 
          5, 250.00, 245.00, 'open', 'ROCT PUT', 1.00, 24250.00))
    
    trade_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return trade_id
