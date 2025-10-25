#!/usr/bin/env python3
"""
Database backup script for PythonAnywhere
Creates timestamped backups of your live data
"""

import sqlite3
import os
import shutil
from datetime import datetime

def backup_database():
    """Create a backup of the current database"""
    
    db_path = 'trades.db'
    backup_dir = 'backups'
    
    # Create backup directory if it doesn't exist
    if not os.path.exists(backup_dir):
        os.makedirs(backup_dir)
        print(f"📁 Created backup directory: {backup_dir}")
    
    if not os.path.exists(db_path):
        print("❌ No database file found to backup")
        return False
    
    # Create timestamped backup filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_filename = f"trades_backup_{timestamp}.db"
    backup_path = os.path.join(backup_dir, backup_filename)
    
    # Copy database file
    shutil.copy2(db_path, backup_path)
    
    # Get database info
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM trades")
    trade_count = cursor.fetchone()[0]
    conn.close()
    
    print(f"✅ Database backup created: {backup_path}")
    print(f"📊 Backup contains {trade_count} trades")
    print(f"💾 Backup size: {os.path.getsize(backup_path)} bytes")
    
    return backup_path

def list_backups():
    """List all available backups"""
    
    backup_dir = 'backups'
    
    if not os.path.exists(backup_dir):
        print("📁 No backup directory found")
        return
    
    backups = [f for f in os.listdir(backup_dir) if f.startswith('trades_backup_') and f.endswith('.db')]
    
    if not backups:
        print("📁 No backups found")
        return
    
    print("📋 Available backups:")
    for backup in sorted(backups, reverse=True):
        backup_path = os.path.join(backup_dir, backup)
        size = os.path.getsize(backup_path)
        modified = datetime.fromtimestamp(os.path.getmtime(backup_path))
        
        # Get trade count from backup
        conn = sqlite3.connect(backup_path)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM trades")
        trade_count = cursor.fetchone()[0]
        conn.close()
        
        print(f"  📄 {backup}")
        print(f"     📊 {trade_count} trades, {size} bytes")
        print(f"     📅 {modified.strftime('%Y-%m-%d %H:%M:%S')}")
        print()

def restore_backup(backup_filename):
    """Restore database from backup"""
    
    backup_dir = 'backups'
    backup_path = os.path.join(backup_dir, backup_filename)
    
    if not os.path.exists(backup_path):
        print(f"❌ Backup file not found: {backup_path}")
        return False
    
    # Create backup of current database
    if os.path.exists('trades.db'):
        current_backup = backup_database()
        print(f"🛡️  Current database backed up to: {current_backup}")
    
    # Restore from backup
    shutil.copy2(backup_path, 'trades.db')
    
    # Verify restoration
    conn = sqlite3.connect('trades.db')
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM trades")
    trade_count = cursor.fetchone()[0]
    conn.close()
    
    print(f"✅ Database restored from: {backup_filename}")
    print(f"📊 Restored database contains {trade_count} trades")
    
    return True

if __name__ == '__main__':
    import sys
    
    if len(sys.argv) > 1:
        command = sys.argv[1]
        
        if command == 'backup':
            backup_database()
        elif command == 'list':
            list_backups()
        elif command == 'restore' and len(sys.argv) > 2:
            restore_backup(sys.argv[2])
        else:
            print("Usage:")
            print("  python3 backup_db.py backup     - Create backup")
            print("  python3 backup_db.py list       - List backups")
            print("  python3 backup_db.py restore <filename> - Restore from backup")
    else:
        # Default: create backup
        backup_database()
