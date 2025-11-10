# Hybrid Database Approach Guide

## Overview

We've implemented a **hybrid approach** that combines:
- **SQLAlchemy Core** for connection pooling and better connection management
- **Raw SQL queries** for maximum flexibility and performance
- **Helper methods** for common query patterns

## Benefits

✅ **Better connection management** - SQLAlchemy handles connection pooling  
✅ **Automatic cleanup** - Context managers ensure connections are closed  
✅ **Backward compatible** - Old code still works with `get_db_connection()`  
✅ **Helper methods** - Common queries are simplified  
✅ **Raw SQL** - Keep all your complex queries as-is  

## Architecture

### Database Helper (`db_helper.py`)

The `DatabaseHelper` class provides:

1. **Connection Management** - SQLAlchemy engine with connection pooling
2. **Query Methods** - Helper methods for common operations
3. **Raw SQL Support** - Execute raw SQL queries with parameters
4. **Context Managers** - Automatic connection cleanup

### Usage Patterns

#### Pattern 1: Using Helper Methods (Recommended for Simple Queries)

```python
from db_helper import get_db_helper

@app.route('/api/accounts', methods=['GET'])
def get_accounts():
    db = get_db_helper()
    accounts = db.get_accounts()
    return jsonify(accounts)
```

#### Pattern 2: Using execute_query (For Complex Queries)

```python
from db_helper import get_db_helper

@app.route('/api/custom-query')
def custom_query():
    db = get_db_helper()
    results = db.execute_query(
        'SELECT * FROM trades WHERE account_id = ? AND trade_date >= ?',
        [account_id, start_date]
    )
    return jsonify(results)
```

#### Pattern 3: Using Context Manager (For Transactions)

```python
from db_helper import get_db_helper
from sqlalchemy import text

@app.route('/api/complex-operation')
def complex_operation():
    db = get_db_helper()
    with db.get_connection() as conn:
        # Multiple operations in one transaction
        conn.execute(text("INSERT INTO trades ..."))
        conn.execute(text("UPDATE cost_basis ..."))
        conn.commit()
```

#### Pattern 4: Backward Compatibility (Old Code Still Works)

```python
# Old code continues to work
conn = get_db_connection()
cursor = conn.cursor()
cursor.execute('SELECT * FROM accounts')
# ...
conn.close()
```

## Available Helper Methods

### Accounts
- `get_accounts(order_by='account_name')` - Get all accounts
- `get_account(account_id)` - Get single account by ID

### Tickers
- `get_ticker(ticker)` - Get ticker by symbol (case-insensitive)
- `get_ticker_by_id(ticker_id)` - Get ticker by ID
- `create_or_get_ticker(ticker, company_name)` - Get or create ticker

### Trades
- `get_trade(trade_id)` - Get single trade with joined ticker info
- `get_trades_filtered(account_id, ticker, start_date, end_date)` - Get filtered trades

### Commissions
- `get_commission_rate(account_id, trade_date)` - Get commission rate for date

### Generic Query Methods
- `execute_query(query, params)` - Execute SELECT and return list of dicts
- `execute_one(query, params)` - Execute SELECT and return first result
- `execute_update(query, params)` - Execute INSERT/UPDATE/DELETE
- `execute_insert(query, params)` - Execute INSERT and return lastrowid
- `execute_script(script)` - Execute multi-statement SQL script

## Migration Path

### Phase 1: New Code (✅ Done)
- Created `db_helper.py` with helper methods
- Updated simple routes to use helpers

### Phase 2: Gradual Migration (In Progress)
- Migrate routes one at a time
- Keep complex queries using raw SQL
- Add new helper methods as needed

### Phase 3: Full Migration (Optional)
- All routes use helper methods
- Complex queries use context managers
- Remove old `get_db_connection()` if desired

## Example: Before and After

### Before (Raw SQLite)
```python
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
```

### After (Using Helper)
```python
@app.route('/api/accounts', methods=['GET'])
def get_accounts():
    try:
        db = get_db_helper()
        accounts = db.get_accounts()
        return jsonify(accounts)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

**Benefits:**
- ✅ 3 lines shorter
- ✅ Automatic connection cleanup
- ✅ No manual dict conversion
- ✅ Better error handling

## Best Practices

1. **Use helper methods** for simple queries
2. **Use `execute_query()`** for complex SELECT queries
3. **Use context managers** for transactions
4. **Keep raw SQL** for complex business logic
5. **Add helper methods** as patterns emerge

## When to Use What

| Scenario | Use |
|----------|-----|
| Simple SELECT | `db.get_accounts()`, `db.get_ticker()` |
| Complex SELECT | `db.execute_query()` |
| INSERT/UPDATE/DELETE | `db.execute_update()`, `db.execute_insert()` |
| Multiple operations | Context manager with `db.get_connection()` |
| Legacy code | Keep using `get_db_connection()` |

## Performance Notes

- SQLAlchemy adds minimal overhead (~1-2ms per query)
- Connection pooling improves performance under load
- Raw SQL queries remain just as fast
- Helper methods are thin wrappers around SQLAlchemy Core

## Troubleshooting

### Connection Errors
If you see connection errors, ensure `init_db_helper()` is called before using `get_db_helper()`.

### Type Errors
Helper methods return dictionaries, not Row objects. Adjust code accordingly.

### Transaction Issues
Use context managers for transactions to ensure proper commit/rollback.

## Next Steps

1. Continue migrating routes to use helpers
2. Add more helper methods as patterns emerge
3. Consider adding ORM models for complex relationships (optional)
4. Document new helper methods as they're added





