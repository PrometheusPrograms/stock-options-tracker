# Testing Guide for Stock Options Tracker

## Setup

1. Install testing dependencies:
```bash
pip install -r requirements.txt
```

## Running Tests

### Run all tests
```bash
pytest
```

### Run specific test categories
```bash
pytest tests/unit/              # Unit tests only
pytest tests/api/               # API tests only
pytest tests/integration/      # Integration tests only
```

### Run with coverage report
```bash
pytest --cov=app --cov-report=html
# Then open htmlcov/index.html in browser
```

### Run with verbose output
```bash
pytest -v
```

## Custom Test Data

To add YOUR own test data:

1. **Edit `tests/unit/test_custom_data.py`**
2. **Find `CUSTOM_TEST_TRADES`** - add your actual trades here
3. **Calculate expected values** manually or in Excel
4. **Add the test data:**

```python
{
    'trade_type': 'ROCT PUT',      # Your trade type
    'ticker': 'TSLA',               # Your ticker
    'strike': 245.00,              # Strike price
    'premium': 2.50,               # Premium per share
    'contracts': 1,                # Number of contracts
    'commission': 1.00,            # Commission
    'expected_margin_capital': 24350.00,  # Manually calculate this
    'expected_total_premium': 250.00,     # premium * contracts * 100
    'expected_running_basis': 250.00,     # Cumulative basis
    'notes': 'My first RIVN PUT trade'
},
```

5. **Calculate Expected Values:**
   - **Margin Capital**: `(strike - (premium - commission)) * contracts * 100`
   - **Total Premium**: `premium * contracts * 100`
   - **Running Basis**: Cumulative sum of all trades

6. **Run your custom tests:**
```bash
pytest tests/unit/test_custom_data.py -v
```

## Example Test Output

```
tests/unit/test_custom_data.py::TestCustomTradeData::test_margin_capital_using_your_data[test0] PASSED
  Testing: My first RIVN PUT trade
  Strike: 10.00, Premium: 0.75, Contracts: 10
  Expected: 9235.00, Got: 9235.00

tests/unit/test_custom_data.py::TestCustomTradeData::test_total_premium_using_your_data[test0] PASSED
  Testing: My first RIVN PUT trade
  Expected: 750.00, Got: 750.00
```

## Test Categories

### Unit Tests (`tests/unit/`)
- Test individual calculation functions
- No database or API calls
- Fast and isolated

### API Tests (`tests/api/`)
- Test Flask endpoints
- Test data format and status codes
- May hit a test database

### Integration Tests (`tests/integration/`)
- Test complete workflows
- Test end-to-end functionality
- May be slower

### Custom Tests (`tests/unit/test_custom_data.py`)
- Use YOUR actual trade data
- Verify calculations match your expectations
- Most important for data accuracy

## Writing Your Own Tests

### 1. Create a new test file
```python
# tests/unit/test_my_feature.py
import pytest

def my_function(input_value):
    # Your function to test
    return input_value * 2

class TestMyFeature:
    def test_basic_functionality(self):
        result = my_function(5)
        assert result == 10
    
    def test_edge_case(self):
        result = my_function(0)
        assert result == 0
```

### 2. Run your specific test
```bash
pytest tests/unit/test_my_feature.py -v
```

## Tips

1. **Start with real data**: Use actual trades from your database
2. **Calculate manually first**: Use Excel or calculator to verify
3. **Test edge cases**: Zero shares, negative values, very large numbers
4. **Run tests often**: After each major change
5. **Add new tests**: When you find bugs, add a test to prevent regression

## Continuous Testing

To run tests automatically on file changes:
```bash
# Install watchdog
pip install pytest-watch

# Watch for changes
ptw
```

## Interpreting Results

- **PASSED** ✅ - Test passed
- **FAILED** ❌ - Expected value didn't match
- **ERROR** 🔴 - Code crashed (check syntax)
- **SKIPPED** ⏭️ - Test was skipped (marked with @pytest.mark.skip)

## Debugging Failed Tests

When a test fails, pytest shows:
- The expected value
- The actual value
- The line that failed

Example:
```
AssertionError: Expected 24350.00, got 24300.00
```

This means your calculation is off by $50. Check the formula!

## GUI Testing

GUI testing uses Selenium to automate browser interactions and test the user interface.

### Setup GUI Testing
```bash
pip3 install selenium webdriver-manager
```

### Start your app first
```bash
python3 app.py
```

### Run GUI tests
```bash
# Run all GUI tests (shows browser window)
PYTHONPATH=. pytest tests/gui/ -v

# Run tests in headless mode (no browser window)
# Edit tests/gui/test_gui_elements.py and uncomment line 18
```

### What GUI Tests Cover
- ✅ Page loads successfully
- ✅ Dashboard section visible
- ✅ Trades section visible
- ✅ Cost basis section visible
- ✅ Forms accept input
- ✅ Buttons work
- ✅ Charts render
- ✅ Navigation works

See `tests/gui/README.md` for detailed GUI testing guide.

## Next Steps

1. **Add your real trades** to `test_custom_data.py`
2. **Calculate expected values** in Excel
3. **Run the tests** and fix any failures
4. **Add more tests** as you discover edge cases
5. **Write GUI tests** for your specific workflows
