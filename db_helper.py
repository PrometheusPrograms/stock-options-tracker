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
        def _set_pragmas(conn, _):
            conn.execute('PRAGMA busy_timeout=5000')

        from sqlalchemy import event
        self.engine = create_engine(
            f'sqlite:///{database_path}',
            poolclass=pool.NullPool,  # open/close per operation — avoids cross-connection write locks
            connect_args={'check_same_thread': False},
            echo=False
        )
        event.listen(self.engine, 'connect', _set_pragmas)
    
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
        conn = sqlite3.connect(self.database_path, timeout=10)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=5000')
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
        """Get a single trade by ID with all joined related data (ticker, account, trade_type)"""
        return self.execute_one('''
            SELECT st.*, t.ticker, t.company_name, tt.type_name, a.account_name
            FROM trades st 
            JOIN tickers t ON st.ticker_id = t.id 
            LEFT JOIN trade_types tt ON st.trade_type_id = tt.id
            LEFT JOIN accounts a ON st.account_id = a.id
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
            query += ' AND st.date_trade_open >= :start_date'
            params['start_date'] = start_date
        
        if end_date:
            query += ' AND st.date_trade_open <= :end_date'
            params['end_date'] = end_date
        
        query += ''' ORDER BY st.date_trade_open DESC, 
                     CASE WHEN a.account_name = 'Rule One' THEN 0 ELSE 1 END,
                     a.account_name'''
        
        return self.execute_query(query, params)
    
    def get_commission_rate(self, account_id: int, date_trade_open: str) -> float:
        """
        Get commission rate in effect for an account on a given date.
        
        Commission rate selection logic:
        - Finds the commission with the latest effective_date that is <= trade_date
        - Example: If commissions are effective on 1/10/2020 and 11/15/2025:
          * Trades on or between 1/10/2020 and before 11/15/2025 use the 1/10/2020 commission
          * Trades on or after 11/15/2025 use the 11/15/2025 commission
        
        Args:
            account_id: Account ID
            date_trade_open: Trade open date (YYYY-MM-DD)
        
        Returns:
            Commission rate (float) or 0.0 if not found
        """
        print(f'[DEBUG] get_commission_rate called with account_id={account_id}, date_trade_open={date_trade_open}', flush=True)
        
        # First, check what commissions exist for this account
        all_commissions = self.execute_query('''
            SELECT id, account_id, effective_date, commission_rate 
            FROM commissions 
            WHERE account_id = :account_id
            ORDER BY effective_date DESC
        ''', {'account_id': account_id})
        
        print(f'[DEBUG] Found {len(all_commissions)} commission entries for account_id={account_id}:', flush=True)
        for comm in all_commissions:
            print(f'  - id={comm["id"]}, effective_date={comm["effective_date"]}, commission_rate={comm["commission_rate"]}', flush=True)
        
        # Ensure account_id is an integer
        account_id = int(account_id)
        
        # Ensure date_trade_open is in YYYY-MM-DD format
        if not isinstance(date_trade_open, str) or len(date_trade_open) != 10:
            print(f'[DEBUG] Invalid date_trade_open format: {date_trade_open}', flush=True)
            return 0.0
        
        # Find the commission rate with the latest effective_date that is <= trade_date
        # This ensures that:
        # - Trades on or after an effective_date use that commission rate
        # - Trades before the next effective_date continue using the previous commission rate
        result = self.execute_one('''
            SELECT commission_rate 
            FROM commissions 
            WHERE account_id = :account_id AND effective_date <= :date_trade_open
            ORDER BY effective_date DESC
            LIMIT 1
        ''', {'account_id': account_id, 'date_trade_open': date_trade_open})
        
        if result:
            print(f'[DEBUG] Commission found: {result["commission_rate"]} for account_id={account_id}, date_trade_open={date_trade_open}', flush=True)
            return float(result['commission_rate'])
        else:
            print(f'[DEBUG] No commission found for account_id={account_id}, date_trade_open={date_trade_open}', flush=True)
            print(f'[DEBUG] Query was: SELECT commission_rate FROM commissions WHERE account_id={account_id} AND effective_date <= "{date_trade_open}" ORDER BY effective_date DESC LIMIT 1', flush=True)
            return 0.0
    
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
    
    # Cache management methods
    
    def refresh_trade_statistics_cache(self, account_id: Optional[int] = None):
        """
        Refresh trade statistics cache by computing from trades table directly
        If account_id is None, refreshes for all accounts
        """
        # Clear existing cache for this account or all accounts
        if account_id:
            self.execute_update(
                'DELETE FROM trade_statistics_cache WHERE account_id = :account_id',
                {'account_id': account_id}
            )
            query = '''
                INSERT INTO trade_statistics_cache 
                (account_id, status, trade_count, total_premium, avg_premium, 
                 total_commission, net_premium, first_trade_date, last_trade_date, cache_key)
                SELECT 
                    account_id, 
                    trade_status as status,
                    COUNT(*) as trade_count,
                    SUM(total_premium) as total_premium,
                    AVG(total_premium) as avg_premium,
                    SUM(commission_per_share * num_of_contracts * 100) as total_commission,
                    SUM(total_premium - (commission_per_share * num_of_contracts * 100)) as net_premium,
                    MIN(date_trade_open) as first_trade_date,
                    MAX(date_trade_open) as last_trade_date,
                    account_id || '_' || COALESCE(trade_status, 'NULL') as cache_key
                FROM trades
                WHERE trade_status != 'roll' AND account_id = :account_id
                GROUP BY account_id, trade_status
            '''
            params = {'account_id': account_id}
        else:
            self.execute_update('DELETE FROM trade_statistics_cache')
            query = '''
                INSERT INTO trade_statistics_cache 
                (account_id, status, trade_count, total_premium, avg_premium, 
                 total_commission, net_premium, first_trade_date, last_trade_date, cache_key)
                SELECT 
                    account_id, 
                    trade_status as status,
                    COUNT(*) as trade_count,
                    SUM(total_premium) as total_premium,
                    AVG(total_premium) as avg_premium,
                    SUM(commission_per_share * num_of_contracts * 100) as total_commission,
                    SUM(total_premium - (commission_per_share * num_of_contracts * 100)) as net_premium,
                    MIN(date_trade_open) as first_trade_date,
                    MAX(date_trade_open) as last_trade_date,
                    account_id || '_' || COALESCE(trade_status, 'NULL') as cache_key
                FROM trades
                WHERE trade_status != 'roll'
                GROUP BY account_id, trade_status
            '''
            params = None
        
        self.execute_update(query, params)
    
    def get_trade_statistics_cache(self, account_id: Optional[int] = None, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Get cached trade statistics
        """
        query = 'SELECT * FROM trade_statistics_cache WHERE 1=1'
        params = {}
        
        if account_id:
            query += ' AND account_id = :account_id'
            params['account_id'] = account_id
        
        if status:
            query += ' AND status = :status'
            params['status'] = status
        
        return self.execute_query(query, params if params else None)
    
    def invalidate_metrics_cache(self, account_id: Optional[int] = None):
        """
        Invalidate metrics cache (delete all or for specific account)
        Cache will be refreshed on next read or via scheduled refresh
        """
        if account_id:
            self.execute_update(
                'DELETE FROM trade_statistics_cache WHERE account_id = :account_id',
                {'account_id': account_id}
            )
            self.execute_update(
                'DELETE FROM bankroll_allocation_cache WHERE account_id = :account_id',
                {'account_id': account_id}
            )
        else:
            self.execute_update('DELETE FROM trade_statistics_cache')
            self.execute_update('DELETE FROM bankroll_allocation_cache')


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

