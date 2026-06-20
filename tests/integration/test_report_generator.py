"""
Report generator for trade automation testing
"""
from typing import List, Dict, Any
from datetime import datetime
from .trade_comparator import ComparisonResult


class TestReport:
    """Test report with summary and detailed results"""
    
    def __init__(self, excel_file: str):
        self.excel_file = excel_file
        self.test_date = datetime.now()
        self.total_tests = 0
        self.matches = 0
        self.mismatches = 0
        self.trade_results: List[Dict[str, Any]] = []
    
    def add_trade_result(self, excel_column: int, trade_id: int, results: List[ComparisonResult]):
        """Add comparison results for a single trade"""
        self.total_tests += 1
        
        mismatches = [r for r in results if not r.match]
        matches = [r for r in results if r.match]
        
        if mismatches:
            self.mismatches += 1
        else:
            self.matches += 1
        
        self.trade_results.append({
            'excel_column': excel_column,
            'trade_id': trade_id,
            'results': results,
            'mismatches': mismatches,
            'matches': matches,
        })
    
    def generate_text_report(self) -> str:
        """Generate text report"""
        lines = []
        lines.append("=" * 60)
        lines.append("Trade Testing Report")
        lines.append("=" * 60)
        lines.append(f"Date: {self.test_date.strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"Excel File: {self.excel_file}")
        lines.append(f"Total Tests: {self.total_tests}")
        lines.append(f"Matches: {self.matches}")
        lines.append(f"Mismatches: {self.mismatches}")
        lines.append("")
        
        if self.mismatches > 0:
            lines.append("=" * 60)
            lines.append("Mismatches")
            lines.append("=" * 60)
            lines.append("")
            
            for trade_result in self.trade_results:
                if trade_result['mismatches']:
                    excel_col = trade_result['excel_column']
                    trade_id = trade_result['trade_id']
                    # Convert column number to Excel letter (E=5, F=6, etc.)
                    # Excel columns start at E (column 5) in OKW format
                    if excel_col <= 26:
                        col_letter = chr(64 + excel_col)
                    elif excel_col <= 702:  # Up to ZZ
                        first_letter = chr(64 + ((excel_col - 1) // 26))
                        second_letter = chr(65 + ((excel_col - 1) % 26))
                        col_letter = first_letter + second_letter
                    else:
                        col_letter = f"Column {excel_col}"
                    
                    lines.append(f"Excel Column {col_letter} (Trade ID: {trade_id}):")
                    
                    for mismatch in trade_result['mismatches']:
                        lines.append(f"  - Field: {mismatch.field_name}")
                        lines.append(f"    Expected: {mismatch.expected}")
                        lines.append(f"    Actual: {mismatch.actual}")
                        if mismatch.difference is not None:
                            lines.append(f"    Difference: {mismatch.difference}")
                    lines.append("")
        
        # Add summary of all fields compared (if no mismatches, show this was a successful test)
        if self.mismatches == 0 and self.total_tests > 0:
            lines.append("=" * 60)
            lines.append("All Tests Passed!")
            lines.append("=" * 60)
            lines.append("")
        
        return "\n".join(lines)
    
    def save_report(self, file_path: str):
        """Save report to file"""
        report_text = self.generate_text_report()
        with open(file_path, 'w') as f:
            f.write(report_text)
        print(f"Report saved to: {file_path}")

