#!/bin/bash
# Quick script to install dependencies and run tests

echo "📦 Installing dependencies..."
pip install -r requirements.txt

echo ""
echo "🧪 Running all tests..."
pytest -v

echo ""
echo "✅ Tests complete!"
echo ""
echo "To run specific tests:"
echo "  pytest tests/unit/test_custom_data.py -v"
echo "  pytest tests/unit/ -v  # All unit tests"
echo "  pytest tests/api/ -v   # All API tests"
