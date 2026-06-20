# Trade Automation Testing

Automated testing framework that validates trade creation by comparing actual database state against Excel file control values.

## Overview

This testing framework:
1. Reads OKW-format Excel files (same format used by `/api/import-excel`)
2. Simulates manual entry via `POST /api/trades` for each trade column
3. Compares actual database state against Excel file data (control/expected values)
4. Generates detailed comparison reports

## Excel File Format

The OKW format uses **rows for fields, columns for trades**:

### Input Data Rows

- **Row 1**: `"TICKER TRADE_TYPE"` (e.g., "SLV ROCT CALL") - Extract ticker and trade_type
- **Row 3**: `date_trade_open` - Trade date
- **Row 5**: `current_price` - Current price
- **Row 8**: `expiration_date` - Expiration date
- **Row 15**: `strike_price` - Strike price
- **Row 21**: `credit_debit` - Credit/debit amount
- **Row 41**: `num_of_contracts` - Number of contracts
- **Row 64**: `trade_status` - Trade status (open, expired, closed, roll, assigned)
- **Row 65**: `roll_indicator` - "ROLL" indicates roll trade

### Expected Calculated Value Rows

Additional rows contain pre-calculated expected values for calculated fields. The row numbers are configured in `test_config.py`:

```python
EXPECTED_VALUE_ROW_MAPPING = {
    57: "days_to_expiration",
    58: "net_credit_per_share",
    59: "risk_capital_per_share",
    60: "margin_capital",
    61: "arorc",
    62: "commission_per_share",
    63: "total_premium",
    64: "num_of_shares",
    # Add more mappings as needed
}
```

**Important**: Update `EXPECTED_VALUE_ROW_MAPPING` in `test_config.py` to match your Excel file structure.

## Configuration

Edit `tests/integration/test_config.py` to configure:

- `TEST_DATABASE_PATH`: Path to database file (default: `inv_track.db`)
- `API_BASE_URL`: API base URL (default: `http://localhost:5005`)
- `EXCEL_FILE_PATH`: Default Excel file path (can be overridden via command line)
- `NUMERIC_TOLERANCE`: Tolerance for numeric comparisons (default: `0.01`)
- `ACCOUNT_ID`: Account ID for testing (default: `9`)
- `EXPECTED_VALUE_ROW_MAPPING`: Mapping of Excel row numbers to expected field names

## Usage

### Basic Usage

```bash
# Run tests with default Excel file (from config)
pytest tests/integration/test_trade_automation.py -v

# Run tests with specific Excel file
pytest tests/integration/test_trade_automation.py::test_trades_from_excel --excel-file=path/to/test_data.xlsx -v

# Run with custom account ID
pytest tests/integration/test_trade_automation.py::test_trades_from_excel --excel-file=path/to/test_data.xlsx --account-id=9 -v
```

### Environment Variables

You can also set configuration via environment variables:

```bash
export TEST_DATABASE_PATH=inv_track.db
export API_BASE_URL=http://localhost:5005
export EXCEL_FILE_PATH=path/to/test_data.xlsx
export NUMERIC_TOLERANCE=0.01
export TEST_ACCOUNT_ID=9

pytest tests/integration/test_trade_automation.py -v
```

## Test Report

After running tests, a detailed report is generated with:

- Total tests executed
- Number of matches
- Number of mismatches
- For each mismatch:
  - Excel column
  - Trade ID
  - Field name
  - Expected value (from Excel)
  - Actual value (from database)
  - Difference (for numeric fields)

The report is saved to a file: `test_report_YYYYMMDD_HHMMSS.txt` in the `tests/integration/` directory.

## Comparison Logic

### Numeric Fields (with tolerance)

Fields like `net_credit_per_share`, `risk_capital_per_share`, `margin_capital`, `arorc`, etc. are compared with a tolerance (default: 0.01).

### Integer Fields (exact match)

Fields like `days_to_expiration`, `num_of_contracts`, `num_of_shares` must match exactly.

### String Fields (exact match)

Fields like `ticker`, `trade_type`, `trade_status` must match exactly.

### Date Fields (exact match)

Dates are normalized to `YYYY-MM-DD` format before comparison.

## Troubleshooting

### Excel file not found

Make sure the Excel file path is correct. Use `--excel-file` option or set `EXCEL_FILE_PATH` in config.

### API connection error

Make sure the Flask server is running on the configured `API_BASE_URL` (default: `http://localhost:5005`).

### Database connection error

Make sure the database file exists at the configured `TEST_DATABASE_PATH`.

### Expected values not found

Update `EXPECTED_VALUE_ROW_MAPPING` in `test_config.py` to match your Excel file structure. The row numbers should correspond to the rows in your Excel file that contain the expected calculated values.

## Files

- `test_config.py`: Configuration settings
- `okw_excel_parser.py`: Excel file parser
- `api_trade_creator.py`: API request builder
- `trade_comparator.py`: Comparison engine
- `test_report_generator.py`: Report generator
- `test_trade_automation.py`: Main test runner
- `README.md`: This file


