"""
OKW Excel file parser for trade automation testing
Reuses/adapts logic from app.py import_excel function
"""
import zipfile
import re
from xml.etree import ElementTree as ET
from typing import Dict, List, Any, Optional
import pandas as pd
from datetime import datetime
from .test_config import INPUT_DATA_ROW_MAPPING, EXPECTED_VALUE_ROW_MAPPING


def parse_okw_excel(excel_path: str) -> List[Dict[str, Any]]:
    """
    Parse OKW format Excel file and extract trade data including expected values
    
    Args:
        excel_path: Path to the Excel file
        
    Returns:
        List of dictionaries, one per trade column, containing:
        - Input data from standard rows (1, 3, 5, 8, 15, 21, 41, 64, 65)
        - Expected calculated values from additional rows (as configured)
        - Column number for reference
    """
    trades = []
    
    with zipfile.ZipFile(excel_path, "r") as z:
        # Shared strings for Excel text values
        shared_strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            shared_xml = ET.parse(z.open("xl/sharedStrings.xml"))
            shared_strings = [t.text for t in shared_xml.findall(".//{*}t")]
        
        # Find the first sheet (use it as default)
        wb = ET.parse(z.open("xl/workbook.xml"))
        sheets = wb.findall(".//{*}sheet")
        if not sheets:
            raise ValueError("Couldn't find any sheets in the workbook")
        
        # Use the first sheet
        sheet_index = 1
        sheet_name = sheets[0].attrib.get("name", "Sheet1")
        print(f"Reading from first sheet: '{sheet_name}' (sheet index {sheet_index})")
        
        sheet_xml = ET.parse(z.open(f"xl/worksheets/sheet{sheet_index}.xml"))
        
        def cell_value(c):
            """Extract cell value from XML element"""
            v = c.find("{*}v")
            if v is None:
                return ""
            if c.attrib.get("t") == "s":
                idx = int(v.text)
                return shared_strings[idx] if idx < len(shared_strings) else ""
            return v.text if v.text else ""
        
        def col_num(ref):
            """Convert Excel column reference (A, B, C...) to number (1, 2, 3...)"""
            m = re.match(r"([A-Z]+)", ref)
            if not m:
                return 1
            col = m.group(1)
            n = 0
            for ch in col:
                n = n * 26 + (ord(ch) - 64)
            return n
        
        # Collect all rows from the sheet
        rows = {}
        for r in sheet_xml.findall(".//{*}row"):
            idx = int(r.attrib["r"])
            row_cells = {}
            for c in r.findall("{*}c"):
                ref = c.attrib.get("r")
                if not ref:
                    continue
                col = col_num(ref)
                if col >= 5:  # read only from column E onward
                    val = cell_value(c)
                    row_cells[col] = val
            if row_cells:
                rows[idx] = row_cells
        
        print(f"Collected {len(rows)} rows from Excel")
    
    # Build trade columns from row 1 (trade_type_raw)
    trade_type_row = rows.get(1, {})
    trade_cols = sorted(trade_type_row.keys())
    
    # Get row 64 for trade_status
    trade_status_row = rows.get(64, {})
    
    # Get row 65 for roll indicator
    roll_indicator_row = rows.get(65, {})
    
    print(f"Row 1 has {len(trade_cols)} columns: {trade_cols[:10]}...")
    print(f"Processing {len(trade_cols)} trade columns")
    
    # Process each trade column
    for col in trade_cols:
        # Check if row 1 has data in this column (trade_type_raw)
        if 1 not in rows or col not in rows[1] or not rows[1][col]:
            continue
        
        trade_data = {
            'excel_column': col,
            'input_data': {},
            'expected_values': {},
        }
        
        # Extract input data from standard rows
        for row_num, field_name in INPUT_DATA_ROW_MAPPING.items():
            if row_num in rows and col in rows[row_num]:
                val = rows[row_num][col]
                # Handle special cases
                if field_name == "trade_status":
                    # Use value from trade_status_row
                    val = trade_status_row.get(col, "")
                elif field_name == "roll_indicator":
                    # Use value from roll_indicator_row
                    val = roll_indicator_row.get(col, "").strip().upper() if roll_indicator_row else ""
                trade_data['input_data'][field_name] = val
        
        # Extract expected calculated values from additional rows
        for row_num, field_name in EXPECTED_VALUE_ROW_MAPPING.items():
            if row_num in rows and col in rows[row_num]:
                val = rows[row_num][col]
                # Convert to appropriate type if possible
                if val:
                    try:
                        # Try to convert to float first (for numeric fields)
                        float_val = float(val)
                        # Check if it's actually an integer
                        if float_val.is_integer():
                            trade_data['expected_values'][field_name] = int(float_val)
                        else:
                            trade_data['expected_values'][field_name] = float_val
                    except (ValueError, TypeError):
                        # Keep as string if conversion fails
                        trade_data['expected_values'][field_name] = val
                else:
                    trade_data['expected_values'][field_name] = None
        
        # Extract ticker and trade_type from trade_type_raw
        trade_type_raw = trade_data['input_data'].get('trade_type_raw', '')
        if trade_type_raw:
            parts = str(trade_type_raw).strip().split()
            if len(parts) >= 2:
                trade_data['input_data']['ticker'] = parts[0]
                trade_data['input_data']['trade_type'] = ' '.join(parts[1:])
            elif len(parts) == 1:
                trade_data['input_data']['ticker'] = parts[0]
                trade_data['input_data']['trade_type'] = 'ROCT PUT'  # Default
            else:
                trade_data['input_data']['ticker'] = 'UNKNOWN'
                trade_data['input_data']['trade_type'] = 'ROCT PUT'
        else:
            trade_data['input_data']['ticker'] = 'UNKNOWN'
            trade_data['input_data']['trade_type'] = 'ROCT PUT'
        
        # Convert date strings to YYYY-MM-DD format if needed
        date_trade_open = trade_data['input_data'].get('date_trade_open', '')
        expiration_date = trade_data['input_data'].get('expiration_date', '')
        
        if date_trade_open:
            try:
                # Try parsing various date formats
                if isinstance(date_trade_open, str):
                    # Try common formats
                    for fmt in ['%Y-%m-%d', '%m/%d/%Y', '%m-%d-%Y', '%d/%m/%Y']:
                        try:
                            dt = datetime.strptime(date_trade_open, fmt)
                            trade_data['input_data']['date_trade_open'] = dt.strftime('%Y-%m-%d')
                            break
                        except ValueError:
                            continue
            except Exception:
                pass  # Keep original value if parsing fails
        
        if expiration_date:
            try:
                if isinstance(expiration_date, str):
                    for fmt in ['%Y-%m-%d', '%m/%d/%Y', '%m-%d-%Y', '%d/%m/%Y']:
                        try:
                            dt = datetime.strptime(expiration_date, fmt)
                            trade_data['input_data']['expiration_date'] = dt.strftime('%Y-%m-%d')
                            break
                        except ValueError:
                            continue
            except Exception:
                pass  # Keep original value if parsing fails
        
        # Convert numeric fields
        for field in ['current_price', 'strike_price', 'credit_debit', 'num_of_contracts']:
            if field in trade_data['input_data']:
                try:
                    val = trade_data['input_data'][field]
                    if val:
                        if field == 'num_of_contracts':
                            trade_data['input_data'][field] = int(float(val))
                        else:
                            trade_data['input_data'][field] = float(val)
                except (ValueError, TypeError):
                    trade_data['input_data'][field] = 0 if field == 'num_of_contracts' else 0.0
        
        trades.append(trade_data)
    
    print(f"Parsed {len(trades)} trades from Excel file")
    return trades


