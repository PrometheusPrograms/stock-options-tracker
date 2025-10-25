#!/bin/bash
# Safe deployment script for PythonAnywhere
# Protects existing live data from being overwritten

echo "🚀 Safe Deployment Script for PythonAnywhere"
echo "============================================="

# Configuration
PROJECT_DIR="/home/greenmangroup/stock-options-tracker"
DB_FILE="$PROJECT_DIR/trades.db"
BACKUP_DIR="$PROJECT_DIR/backups"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

echo "📁 Project directory: $PROJECT_DIR"
echo "💾 Database file: $DB_FILE"

# Check if database exists and has data
if [ -f "$DB_FILE" ]; then
    echo "🔍 Checking existing database..."
    
    # Count existing trades
    TRADE_COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM trades;" 2>/dev/null || echo "0")
    
    if [ "$TRADE_COUNT" -gt 0 ]; then
        echo "⚠️  Found $TRADE_COUNT existing trades in database"
        echo "🛡️  Creating backup before deployment..."
        
        # Create timestamped backup
        BACKUP_FILE="$BACKUP_DIR/trades_backup_$(date +%Y%m%d_%H%M%S).db"
        cp "$DB_FILE" "$BACKUP_FILE"
        echo "✅ Backup created: $BACKUP_FILE"
        
        echo "📋 Deployment options:"
        echo "1. Deploy code only (keep existing data)"
        echo "2. Deploy with test data (overwrite existing data)"
        echo "3. Cancel deployment"
        
        read -p "Choose option (1-3): " choice
        
        case $choice in
            1)
                echo "🚀 Deploying code only..."
                cd "$PROJECT_DIR"
                git pull origin main
                echo "✅ Code deployed successfully"
                echo "💾 Existing data preserved"
                ;;
            2)
                echo "⚠️  WARNING: This will overwrite existing data!"
                read -p "Are you sure? Type 'yes' to confirm: " confirm
                if [ "$confirm" = "yes" ]; then
                    echo "🚀 Deploying with test data..."
                    cd "$PROJECT_DIR"
                    git pull origin main
                    python3 setup_test_data.py
                    echo "✅ Deployment completed with test data"
                else
                    echo "❌ Deployment cancelled"
                    exit 1
                fi
                ;;
            3)
                echo "❌ Deployment cancelled"
                exit 0
                ;;
            *)
                echo "❌ Invalid option"
                exit 1
                ;;
        esac
    else
        echo "📊 Database exists but is empty"
        echo "🚀 Deploying with test data..."
        cd "$PROJECT_DIR"
        git pull origin main
        python3 setup_test_data.py
        echo "✅ Deployment completed with test data"
    fi
else
    echo "📊 No database found"
    echo "🚀 Deploying with test data..."
    cd "$PROJECT_DIR"
    git pull origin main
    python3 setup_test_data.py
    echo "✅ Deployment completed with test data"
fi

echo ""
echo "🎉 Deployment completed successfully!"
echo "🌐 Your app should be available at: https://greenmangroup.pythonanywhere.com"
echo "💡 Don't forget to reload your web app in PythonAnywhere!"
