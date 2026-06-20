#!/usr/bin/env python3
"""
Nightly script to refresh metrics cache tables.
Can be run via cron or scheduled task.

Usage:
    python refresh_metrics_cache.py [--account-id ACCOUNT_ID]
    
If --account-id is not provided, refreshes cache for all accounts.
"""

import sys
import os
import argparse

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db_helper import init_db_helper, get_db_helper

def main():
    parser = argparse.ArgumentParser(description='Refresh metrics cache tables')
    parser.add_argument('--account-id', type=int, help='Account ID to refresh (optional, refreshes all if not provided)')
    parser.add_argument('--database', default='trades.db', help='Database file path (default: trades.db)')
    args = parser.parse_args()
    
    # Initialize database helper
    db = init_db_helper(args.database)
    
    # Refresh cache
    print(f"Refreshing metrics cache{' for account ' + str(args.account_id) if args.account_id else ' for all accounts'}...")
    db.refresh_trade_statistics_cache(account_id=args.account_id)
    print("Metrics cache refreshed successfully!")

if __name__ == '__main__':
    main()





