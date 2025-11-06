# Database Migration Guide

This project uses a simple migration system to safely manage database schema changes in production.

## Overview

Instead of manually modifying the database schema in `init_db()`, we now use numbered migration files that:
- Track which migrations have been applied
- Run new migrations automatically on startup
- Prevent duplicate migrations
- Allow safe schema updates in production

## Migration System

### Files Structure

```
migrations/
├── __init__.py          # Package marker
├── migrate.py           # Migration runner
└── 001_initial_schema.sql  # Initial schema migration
```

### How It Works

1. **Migration Files**: SQL files in `migrations/` directory named `NNN_description.sql`
   - Example: `001_initial_schema.sql`, `002_add_user_table.sql`
   
2. **Migration Tracking**: A `schema_migrations` table tracks which migrations have been applied

3. **Automatic Execution**: Migrations run automatically:
   - On app startup (via `@app.before_first_request`)
   - When running `python app.py` directly
   - When running `python migrations/migrate.py` manually

## Creating a New Migration

### Step 1: Create Migration File

Create a new SQL file in `migrations/` directory:

```bash
# Example: migrations/002_add_new_column.sql
```

### Step 2: Write Migration SQL

Write the SQL statements needed for your schema change:

```sql
-- Migration: Add new_column to trades table
-- Safe to run multiple times
ALTER TABLE trades ADD COLUMN new_column TEXT DEFAULT NULL;
```

**Important**: Your SQL should be idempotent (safe to run multiple times) or use `IF NOT EXISTS` checks.

### Step 3: Test Locally

```bash
# Test migration manually
python migrations/migrate.py

# Or start the app
python app.py
```

### Step 4: Commit and Deploy

```bash
git add migrations/002_add_new_column.sql
git commit -m "Add migration: add new_column to trades"
git push
```

On production, the migration will run automatically on next app restart.

## Manual Migration Execution

You can run migrations manually:

```bash
# From project root
python migrations/migrate.py
```

## Migration Best Practices

1. **Always use numbered prefixes**: `001_`, `002_`, etc.
2. **Make migrations idempotent**: Use `IF NOT EXISTS`, `OR IGNORE`, or check before altering
3. **Test migrations**: Test on a copy of production data first
4. **One change per migration**: Keep migrations focused and atomic
5. **Backup before migrating**: Always backup production database before running migrations

## Current Migrations

- `001_initial_schema.sql`: Initial database schema with all base tables

## Migration Status

Check which migrations have been applied:

```python
from migrations.migrate import get_applied_migrations
import sqlite3

conn = sqlite3.connect('trades.db')
conn.row_factory = sqlite3.Row
applied = get_applied_migrations(conn)
print(f"Applied migrations: {applied}")
```

## Troubleshooting

### Migration fails on startup

If a migration fails, the app will:
1. Log the error
2. Fall back to `init_db()` for initial setup
3. Continue running (but migrations won't be applied)

**Fix**: Review the migration SQL, fix any errors, and restart the app.

### Duplicate migration numbers

Migration numbers must be unique. If you create a duplicate:
- Rename the file to use the next available number
- Update any references in your code

### Production Deployment

For production deployments:
1. Backup the database first
2. Pull latest code
3. Restart the application
4. Migrations will run automatically
5. Check logs to confirm migrations applied

## Converting from init_db()

To convert existing `init_db()` logic to migrations:

1. Identify schema changes that are conditional (checking if columns exist, etc.)
2. Create a migration file for each logical schema change
3. Keep `init_db()` as a fallback for initial setup
4. Gradually move logic from `init_db()` to numbered migrations



