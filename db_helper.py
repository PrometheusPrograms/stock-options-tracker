"""
Database helper module using SQLAlchemy Core for connection management
while maintaining raw SQL queries for maximum flexibility.
"""
from sqlalchemy import create_engine, text, pool
from sqlalchemy.engine import Engine
from contextlib import contextmanager
import sqlite3
from typing import Optional, List, Dict, Any
import logging

logger = logging.getLogger(__name__)

class DatabaseHelper:
    """Database helper using SQLAlchemy Core for connection pooling"""
    
    def __init__(self, database_path: str):
        """
        Initialize database helper with SQLAlchemy engine
        
        Args:
            database_path: Path to SQLite database file
        """
        self.database_path = database_path
        # Create engine with connection pooling
        # SQLite doesn't support true connection pooling, but we get better error handling
        self.engine = create_engine(
            f'sqlite:///{database_path}',
            poolclass=pool.StaticPool,  # SQLite uses StaticPool
            connect_args={'check_same_thread': False},  # Allow multi-threading
            echo=False  # Set to True for SQL query logging
        )
    
    @contextmanager
    def get_connection(self):
        """
        Get a database connection with automatic cleanup
        
        Usage:
            with db_helper.get_connection() as conn:
                result = conn.execute(text("SELECT * FROM trades"))
        """
        conn = self.engine.connect()
        try:
            # Set row factory for dict-like access (SQLAlchemy style)
            yield conn
        finally:
            conn.close()
    
    def get_raw_connection(self):
        """
        Get a raw sqlite3 connection (for backward compatibility)
        
        Returns:
            sqlite3.Connection with row_factory set to sqlite3.Row
        """
        conn = sqlite3.connect(self.database_path)
        conn.row_factory = sqlite3.Row
        return conn
    
    def execute_query(self, query: str, params: Optional[Dict] = None) -> List[Dict[str, Any]]:
        """
        Execute a SELECT query and return results as list of dicts
        
        Args:
            query: SQL query string
            params: Optional dictionary of parameters for parameterized query
        
        Returns:
            List of dictionaries (one per row)
        """
        with self.get_connection() as conn:
            if params:
                result = conn.execute(text(query), params)
            else:
                result = conn.execute(text(query))
            
            # Convert to list of dicts
            rows = result.fetchall()
            return [dict(row._mapping) for row in rows]
    
    def execute_one(self, query: str, params: Optional[Dict] = None) -> Optional[Dict[str, Any]]:
        """
        Execute a SELECT query and return first result as dict
        
        Args:
            query: SQL query string
            params: Optional dictionary of parameters for parameterized query
        
        Returns:
            Dictionary with row data or None if no results
        """
        rows = self.execute_query(query, params)
        return rows[0] if rows else None
    
    def execute_update(self, query: str, params: Optional[Dict] = None) -> int:
        """
        Execute an INSERT/UPDATE/DELETE query
        
        Args:
            query: SQL query string
            params: Optional dictionary of parameters for parameterized query
        
        Returns:
            Number of rows affected
        """
        with self.get_connection() as conn:
            if params:
                result = conn.execute(text(query), params)
            else:
                result = conn.execute(text(query))
            conn.commit()
            return result.rowcount
    
    def execute_script(self, script: str):
        """
        Execute a multi-statement SQL script
        
        Args:
            script: SQL script string (can contain multiple statements)
        """
        with self.get_connection() as conn:
            conn.execute(text(script))
            conn.commit()
    
    def execute_insert(self, query: str, params: Optional[Dict] = None) -> int:
        """
        Execute an INSERT query and return the lastrowid
        
        Args:
            query: SQL INSERT query string
            params: Optional dictionary of parameters for parameterized query
        
        Returns:
            ID of inserted row
        """
        with self.get_connection() as conn:
            if params:
                result = conn.execute(text(query), params)
            else:
                result = conn.execute(text(query))
            conn.commit()
            # Get lastrowid from result
            return result.lastrowid
    
    # Query helper methods for common patterns
    
    def get_accounts(self, order_by: str = 'account_name') -> List[Dict[str, Any]]:
        """Get all accounts"""
        return self.execute_query(f'SELECT * FROM accounts ORDER BY {order_by}')
    
    def get_account(self, account_id: int) -> Optional[Dict[str, Any]]:
        """Get a single account by ID"""
        return self.execute_one('SELECT * FROM accounts WHERE id = :account_id', {'account_id': account_id})
    
    def get_ticker(self, ticker: str) -> Optional[Dict[str, Any]]:
        """Get ticker by symbol (case-insensitive)"""
        return self.execute_one(
            'SELECT * FROM tickers WHERE UPPER(ticker) = UPPER(:ticker)',
            {'ticker': ticker}
        )
    
    def get_ticker_by_id(self, ticker_id: int) -> Optional[Dict[str, Any]]:
        """Get ticker by ID"""
        return self.execute_one('SELECT * FROM tickers WHERE id = :ticker_id', {'ticker_id': ticker_id})
    
    def get_trade(self, trade_id: int) -> Optional[Dict[str, Any]]:
        """Get a single trade by ID with joined ticker info"""
        return self.execute_one('''
            SELECT st.*, t.ticker, t.company_name 
            FROM trades st 
            JOIN tickers t ON st.ticker_id = t.id 
            WHERE st.id = :trade_id
        ''', {'trade_id': trade_id})
    
    def get_trades_filtered(
        self,
        account_id: Optional[int] = None,
        ticker: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Get trades with optional filters
        
        Args:
            account_id: Filter by account ID
            ticker: Filter by ticker symbol
            start_date: Filter trades on or after this date
            end_date: Filter trades on or before this date
        
        Returns:
            List of trade dictionaries
        """
        query = '''
            SELECT st.*, s.ticker, s.company_name, tt.type_name, a.account_name
            FROM trades st 
            JOIN tickers s ON st.ticker_id = s.id 
            LEFT JOIN trade_types tt ON st.trade_type_id = tt.id
            LEFT JOIN accounts a ON st.account_id = a.id
            WHERE 1=1
        '''
        params = {}
        
        if account_id:
            query += ' AND st.account_id = :account_id'
            params['account_id'] = account_id
            print(f'[DEBUG] db_helper.get_trades_filtered - filtering by account_id: {account_id}')
        
        if ticker:
            query += ' AND s.ticker = :ticker'
            params['ticker'] = ticker.upper()
        
        if start_date:
            query += ' AND st.trade_date >= :start_date'
            params['start_date'] = start_date
        
        if end_date:
            query += ' AND st.trade_date <= :end_date'
            params['end_date'] = end_date
        
        query += ''' ORDER BY st.trade_date DESC, 
                     CASE WHEN a.account_name = 'Rule One' THEN 0 ELSE 1 END,
                     a.account_name'''
        
        return self.execute_query(query, params)
    
    def get_commission_rate(self, account_id: int, trade_date: str) -> float:
        """
        Get commission rate in effect for an account on a given date
        
        Args:
            account_id: Account ID
            trade_date: Trade date (YYYY-MM-DD)
        
        Returns:
            Commission rate (float) or 0.0 if not found
        """
        result = self.execute_one('''
            SELECT commission_rate 
            FROM commissions 
            WHERE account_id = :account_id AND effective_date <= :trade_date
            ORDER BY effective_date DESC
            LIMIT 1
        ''', {'account_id': account_id, 'trade_date': trade_date})
        
        return result['commission_rate'] if result else 0.0
    
    def create_or_get_ticker(self, ticker: str, company_name: Optional[str] = None) -> int:
        """
        Get existing ticker or create new one
        
        Args:
            ticker: Ticker symbol
            company_name: Optional company name
        
        Returns:
            Ticker ID
        """
        existing = self.get_ticker(ticker)
        if existing:
            return existing['id']
        
        # Create new ticker
        company_name = company_name or ticker.upper()
        ticker_id = self.execute_insert(
            'INSERT INTO tickers (ticker, company_name) VALUES (:ticker, :company_name)',
            {'ticker': ticker.upper(), 'company_name': company_name}
        )
        return ticker_id


# Global database helper instance
_db_helper: Optional[DatabaseHelper] = None

def init_db_helper(database_path: str) -> DatabaseHelper:
    """Initialize and return the global database helper"""
    global _db_helper
    _db_helper = DatabaseHelper(database_path)
    return _db_helper

def get_db_helper() -> DatabaseHelper:
    """Get the global database helper instance"""
    global _db_helper
    if _db_helper is None:
        raise RuntimeError("Database helper not initialized. Call init_db_helper() first.")
    return _db_helper

