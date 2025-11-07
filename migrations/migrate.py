"""
Simple migration system for SQLite database
Tracks applied migrations and runs new ones in order
"""
import sqlite3
import os
import glob
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent
DATABASE = 'trades.db'

def get_migration_files():
    """Get all migration files sorted by number"""
    migration_files = sorted(glob.glob(str(MIGRATIONS_DIR / '*.sql')))
    return migration_files

def get_applied_migrations(conn):
    """Get list of applied migration numbers"""
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('SELECT version FROM schema_migrations ORDER BY version')
    applied = [row[0] for row in cursor.fetchall()]
    return applied

def apply_migration(conn, migration_file):
    """Apply a single migration file. Returns the connection (may be new if reconnected)."""
    migration_number = int(Path(migration_file).stem.split('_')[0])
    cursor = conn.cursor()
    
    # Special handling for migration 011: ALTER TABLE ADD COLUMN might fail if column exists
    if migration_number == 11:
        # Check if is_default column already exists
        cursor.execute("PRAGMA table_info(accounts)")
        columns = [row[1] for row in cursor.fetchall()]
        if 'is_default' in columns:
            # Column already exists, skip migration but mark as applied
            print(f"⚠ Skipping migration {migration_number}: is_default column already exists")
            cursor.execute('INSERT INTO schema_migrations (version) VALUES (?)', (migration_number,))
            conn.commit()
            return conn
    
    # Safety check: Clean up any leftover trades_new table before starting migration
    # This prevents issues if a previous migration failed partway
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades_new'")
    if cursor.fetchone():
        print(f"⚠ Warning: Found leftover trades_new table before migration {migration_number}. Cleaning up...")
        try:
            cursor.execute("SELECT COUNT(*) as count FROM trades")
            trades_exists = cursor.fetchone() is not None
            if trades_exists:
                # trades exists, so trades_new is leftover - drop it
                cursor.execute('DROP TABLE trades_new')
                conn.commit()
                print("✓ Cleaned up leftover trades_new table")
            else:
                # trades doesn't exist, trades_new might be the actual table - complete migration
                cursor.execute("SELECT COUNT(*) as count FROM trades_new")
                if cursor.fetchone()['count'] > 0:
                    print("⚠ trades_new has data but trades doesn't exist. Completing migration...")
                    cursor.execute('DROP VIEW IF EXISTS v_trade_summary')
                    cursor.execute('DROP VIEW IF EXISTS v_cost_basis_summary')
                    cursor.execute('DROP VIEW IF EXISTS v_cash_flow_summary')
                    cursor.execute('ALTER TABLE trades_new RENAME TO trades')
                    conn.commit()
                    print("✓ Completed incomplete migration: renamed trades_new to trades")
        except Exception as e:
            print(f"⚠ Error cleaning up trades_new: {e}")
            # Continue with migration anyway
    
    # Special handling for migration 002: check if commission_paid exists
    if migration_number == 2:
        # Check if trades table exists and has commission_paid column
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades'")
        if cursor.fetchone():
            cursor.execute("PRAGMA table_info(trades)")
            columns = [row[1] for row in cursor.fetchall()]
            if 'commission_paid' not in columns:
                # Column doesn't exist (already renamed or new database), skip migration
                print(f"⚠ Skipping migration {migration_number}: commission_paid column doesn't exist (already uses commission_per_share)")
                cursor.execute('INSERT INTO schema_migrations (version) VALUES (?)', (migration_number,))
                conn.commit()
                return conn  # Return connection to maintain consistency
        
        # For migration 002, explicitly drop views BEFORE executing the migration SQL
        # This ensures views are fully dropped before the table rename operation
        print("Dropping views that depend on trades table...")
        # Find all views that reference the trades table (check for FROM trades or JOIN trades)
        cursor.execute("""
            SELECT name FROM sqlite_master 
            WHERE type='view' 
            AND (sql LIKE '%FROM trades%' OR sql LIKE '%JOIN trades%' OR sql LIKE '%trades t%')
        """)
        views_to_drop = [row[0] for row in cursor.fetchall()]
        # Also explicitly drop known views
        known_views = ['v_trade_summary', 'v_cost_basis_summary', 'v_cash_flow_summary']
        for view_name in known_views:
            if view_name not in views_to_drop:
                views_to_drop.append(view_name)
        
        # Drop views in a separate transaction to ensure they're fully dropped
        for view_name in views_to_drop:
            try:
                cursor.execute(f'DROP VIEW IF EXISTS {view_name}')
                print(f"  Dropped view: {view_name}")
            except Exception as e:
                print(f"  Warning: Could not drop view {view_name}: {e}")
        
        conn.commit()  # Commit the view drops before proceeding
        
        # Verify views are actually dropped
        cursor.execute("SELECT name FROM sqlite_master WHERE type='view'")
        remaining_views = [row[0] for row in cursor.fetchall()]
        if remaining_views:
            print(f"  Warning: Some views still exist: {remaining_views}")
            # Force drop any remaining views that reference trades
            for view_name in remaining_views:
                try:
                    cursor.execute(f'DROP VIEW IF EXISTS {view_name}')
                    print(f"  Force dropped view: {view_name}")
                except Exception as e:
                    print(f"  Error force dropping view {view_name}: {e}")
            conn.commit()
        
        # Close and reopen connection to refresh SQLite's schema cache
        # This ensures SQLite recognizes that views are dropped before attempting table rename
        print("  Refreshing SQLite schema cache by closing and reopening connection...")
        conn.close()
        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
    
    # Read and execute migration SQL
    with open(migration_file, 'r') as f:
        sql = f.read()
    
    # For migration 002, 007, 008, and 009, handle view dropping before table modification
    if migration_number == 2 or migration_number == 7 or migration_number == 8 or migration_number == 9:
        # Explicitly drop views BEFORE executing the migration SQL
        # This ensures views are fully dropped before the table modification operation
        print("Dropping views that depend on trades table...")
        # Find all views that reference the trades table
        cursor.execute("""
            SELECT name FROM sqlite_master 
            WHERE type='view' 
            AND (sql LIKE '%FROM trades%' OR sql LIKE '%JOIN trades%' OR sql LIKE '%trades t%')
        """)
        views_to_drop = [row[0] for row in cursor.fetchall()]
        # Also explicitly drop known views
        known_views = ['v_trade_summary', 'v_cost_basis_summary', 'v_cash_flow_summary']
        for view_name in known_views:
            if view_name not in views_to_drop:
                views_to_drop.append(view_name)
        
        # Drop views in a separate transaction to ensure they're fully dropped
        for view_name in views_to_drop:
            try:
                cursor.execute(f'DROP VIEW IF EXISTS {view_name}')
                print(f"  Dropped view: {view_name}")
            except Exception as e:
                print(f"  Warning: Could not drop view {view_name}: {e}")
        
        conn.commit()  # Commit the view drops before proceeding
        
        # Verify views are actually dropped
        cursor.execute("SELECT name FROM sqlite_master WHERE type='view'")
        remaining_views = [row[0] for row in cursor.fetchall()]
        if remaining_views:
            print(f"  Warning: Some views still exist: {remaining_views}")
            # Force drop any remaining views that reference trades
            for view_name in remaining_views:
                try:
                    cursor.execute(f'DROP VIEW IF EXISTS {view_name}')
                    print(f"  Force dropped view: {view_name}")
                except Exception as e:
                    print(f"  Error force dropping view {view_name}: {e}")
            conn.commit()
        
        # Close and reopen connection to refresh SQLite's schema cache
        # This ensures SQLite recognizes that views are dropped before attempting table rename
        print("  Refreshing SQLite schema cache by closing and reopening connection...")
        conn.close()
        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
    
    # For migration 002, split the SQL into steps to avoid view dependency issues
    if migration_number == 2:
        # Split SQL into parts: before rename, rename, after rename
        parts = sql.split('-- Rename new table')
        if len(parts) == 2:
            before_rename = parts[0]
            after_rename = '-- Rename new table' + parts[1]
            
            # Execute everything before the rename
            try:
                cursor.executescript(before_rename)
                conn.commit()  # Commit before rename
                
                # Execute the rename operation
                cursor.execute('ALTER TABLE trades_new RENAME TO trades')
                conn.commit()  # Commit the rename
                
                # Execute everything after the rename (recreate views)
                cursor.executescript(after_rename)
                conn.commit()  # Commit view recreation
            except Exception as e:
                raise
        else:
            # If we can't split, fall back to normal execution
            try:
                cursor.executescript(sql)
            except Exception as e:
                raise
    elif migration_number == 7 or migration_number == 8 or migration_number == 9 or migration_number == 10:
        # For migration 007 and 008, split the SQL into steps similar to 002
        # Split SQL into parts: before rename (including DROP TABLE), rename, after rename (views only)
        parts = sql.split('-- Rename new table')
        if len(parts) == 2:
            # before_rename includes everything up to "-- Rename new table"
            # This includes: CREATE TABLE trades_new, INSERT, DROP TABLE trades
            before_rename = parts[0]
            # after_rename includes "-- Rename new table", "ALTER TABLE trades_new RENAME TO trades", and views
            after_rename_full = '-- Rename new table' + parts[1]
            
            # Split after_rename_full to separate the ALTER TABLE from the views
            after_parts = after_rename_full.split('-- Recreate views')
            if len(after_parts) == 2:
                # The ALTER TABLE is in after_parts[0], views are in after_parts[1]
                rename_part = after_parts[0].strip()
                views_part = '-- Recreate views' + after_parts[1]
                
                # Execute everything before the rename (create table, copy data, drop old table)
                try:
                    cursor.executescript(before_rename)
                    conn.commit()  # Commit before rename
                    
                    # Execute the rename operation (from rename_part)
                    # Extract just the ALTER TABLE statement
                    if 'ALTER TABLE trades_new RENAME TO trades' in rename_part:
                        cursor.execute('ALTER TABLE trades_new RENAME TO trades')
                        conn.commit()  # Commit the rename
                    else:
                        # Fallback: try to execute the rename_part as is
                        cursor.executescript(rename_part)
                        conn.commit()
                    
                    # Execute views (references trades, which now exists)
                    cursor.executescript(views_part)
                    conn.commit()  # Commit view recreation
                except Exception as e:
                    raise
            else:
                # Can't split, fall back to normal execution
                try:
                    cursor.executescript(sql)
                except Exception as e:
                    raise
        else:
            # If we can't split, fall back to normal execution
            try:
                cursor.executescript(sql)
            except Exception as e:
                raise
    else:
        # Execute migration (can contain multiple statements)
        try:
            cursor.executescript(sql)
        except Exception as e:
            # If migration fails, check if trades_new was created and clean it up
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades_new'")
            if cursor.fetchone():
                print(f"⚠ Migration {migration_number} failed. Cleaning up trades_new table...")
                cursor.execute('DROP TABLE IF EXISTS trades_new')
                conn.rollback()
            raise
    
    # Safety check: After migration, ensure trades_new doesn't exist (it should have been renamed)
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades_new'")
    if cursor.fetchone():
        print(f"⚠ Warning: trades_new still exists after migration {migration_number}. This should not happen.")
        # Check if trades exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trades'")
        if cursor.fetchone():
            # trades exists, so trades_new is leftover - drop it
            cursor.execute('DROP TABLE trades_new')
            print("✓ Cleaned up leftover trades_new table after migration")
        else:
            # trades doesn't exist, rename trades_new to trades
            cursor.execute('ALTER TABLE trades_new RENAME TO trades')
            print("✓ Completed migration: renamed trades_new to trades")
    
    # Record migration as applied
    cursor.execute('INSERT INTO schema_migrations (version) VALUES (?)', (migration_number,))
    conn.commit()
    
    print(f"✓ Applied migration {migration_number}: {Path(migration_file).name}")
    return conn  # Return connection in case it was recreated

def run_migrations():
    """Run all pending migrations"""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    
    try:
        applied = get_applied_migrations(conn)
        migration_files = get_migration_files()
        
        pending = []
        for migration_file in migration_files:
            migration_number = int(Path(migration_file).stem.split('_')[0])
            if migration_number not in applied:
                pending.append((migration_number, migration_file))
        
        if not pending:
            print("No pending migrations")
            return
        
        print(f"Found {len(pending)} pending migration(s)")
        
        # Apply migrations in order
        for migration_number, migration_file in sorted(pending):
            print(f"Applying migration {migration_number}...")
            conn = apply_migration(conn, migration_file)  # Get updated connection
        
        print("All migrations applied successfully")
        
    except Exception as e:
        print(f"Migration error: {e}")
        if conn:
            try:
                conn.rollback()
            except:
                pass
        raise
    finally:
        if conn:
            try:
                conn.close()
            except:
                pass

if __name__ == '__main__':
    run_migrations()

