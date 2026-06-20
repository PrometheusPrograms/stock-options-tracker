# Metrics Cache System

## Overview

The metrics cache system precomputes trade summaries and bankroll allocation metrics to avoid expensive recalculations on every UI refresh. This significantly improves performance for metrics-heavy UI elements.

## Cache Tables

### 1. `trade_statistics_cache`
Caches aggregated trade statistics per account and status:
- Trade counts
- Total/avg premiums
- Total commissions
- Net premiums
- First/last trade dates

### 2. `bankroll_allocation_cache`
Caches bankroll allocation metrics:
- Starting bankroll
- Total premiums
- Used in trades
- Available bankroll
- Breakdown by trade type

### 3. `trade_statistics_cache`
Materialized version of `v_trade_statistics` view for faster access.

## Cache Refresh Strategies

### 1. On Write Events (Automatic)
Cache is automatically invalidated when:
- New trades are created (`add_trade()`)
- Trade status is updated (`update_trade_status()`)
- Trade fields are updated (via `update_trade_field()`)

The cache is invalidated (deleted) for the affected account, and will be refreshed on the next read or via scheduled refresh.

### 2. Nightly Refresh (Recommended)
Run the refresh script nightly via cron:

```bash
# Add to crontab (runs at 2 AM daily)
0 2 * * * cd /path/to/inv_track && python3 refresh_metrics_cache.py
```

Or refresh for a specific account:
```bash
python3 refresh_metrics_cache.py --account-id 9
```

### 3. On-Demand Refresh
Use the API endpoint to refresh cache:

```bash
# Refresh all accounts
curl -X POST http://localhost:5000/api/refresh-metrics-cache

# Refresh specific account
curl -X POST http://localhost:5000/api/refresh-metrics-cache \
  -H "Content-Type: application/json" \
  -d '{"account_id": 9}'
```

## Database Helper Methods

### `refresh_trade_statistics_cache(account_id=None)`
Refreshes the trade statistics cache from the trades table.
- If `account_id` is provided, refreshes only that account
- If `account_id` is None, refreshes all accounts

### `get_trade_statistics_cache(account_id=None, status=None)`
Retrieves cached trade statistics.
- Filters by account_id and/or status if provided

### `invalidate_metrics_cache(account_id=None)`
Invalidates (deletes) cache entries.
- If `account_id` is provided, invalidates only that account
- If `account_id` is None, invalidates all cache

## Usage in API Endpoints

The cache can be used in API endpoints to serve precomputed metrics:

```python
# Check cache first
cached_stats = db.get_trade_statistics_cache(account_id=account_id, status='open')
if cached_stats:
    return jsonify(cached_stats)
else:
    # Fallback to live calculation
    stats = calculate_trade_statistics(account_id, status='open')
    # Optionally refresh cache
    db.refresh_trade_statistics_cache(account_id=account_id)
    return jsonify(stats)
```

## Migration

The cache tables are created via migration `017_add_metrics_cache_tables.sql`. Run migrations to apply:

```bash
python3 migrations/migrate.py
```

## Performance Benefits

- **Before**: Complex aggregations calculated on every UI refresh
- **After**: Precomputed metrics served instantly from cache tables
- **Refresh**: Cache updated nightly or on write events

This reduces database load and improves UI responsiveness, especially for dashboards with multiple metrics.





