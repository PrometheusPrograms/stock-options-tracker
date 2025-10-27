# GUI Testing Guide

## What is GUI Testing?

GUI testing uses Selenium to automate a real browser (Chrome) to test your application's user interface. It:
- Opens a browser window
- Navigates to your app
- Clicks buttons, fills forms, checks elements
- Verifies everything works as expected

## Setup

### 1. Install Dependencies
```bash
pip3 install selenium webdriver-manager
```

### 2. Make sure Flask is running
```bash
# In another terminal
python3 app.py
```

### 3. Run GUI Tests
```bash
# Run all GUI tests (with visible browser)
PYTHONPATH=. pytest tests/gui/ -v

# Run only fast tests (skip slow ones)
PYTHONPATH=. pytest tests/gui/ -v -m "not slow"
```

## Writing Your Own GUI Tests

### Example: Test Add Trade Modal

```python
def test_open_add_trade_modal(self, driver, app_url):
    """Test opening the add trade modal"""
    driver.get(app_url)
    time.sleep(2)
    
    # Click the add trade button
    add_button = driver.find_element(By.ID, "add-trade-button")
    add_button.click()
    
    # Wait for modal to appear
    modal = WebDriverWait(driver, 10).until(
        EC.visibility_of_element_located((By.ID, "addTradeModal"))
    )
    
    # Verify modal is visible
    assert modal.is_displayed()
```

### Example: Test Form Submission

```python
def test_submit_trade_form(self, driver, app_url):
    """Test submitting a trade form"""
    driver.get(app_url)
    time.sleep(2)
    
    # Open modal
    driver.find_element(By.CSS_SELECTOR, '[data-bs-target="#roctPutModal"]').click()
    time.sleep(1)
    
    # Fill in form
    driver.find_element(By.ID, "roctPut-ticker").send_keys("RIVN")
    driver.find_element(By.ID, "roctPut-premium").send_keys("0.75")
    
    # Submit form
    driver.find_element(By.ID, "roctPut-add-btn").click()
    
    # Wait for success/error
    time.sleep(2)
```

## Common Selenium Actions

### Finding Elements
```python
# By ID
element = driver.find_element(By.ID, "my-id")

# By class name
elements = driver.find_elements(By.CLASS_NAME, "my-class")

# By CSS selector
element = driver.find_element(By.CSS_SELECTOR, ".my-class button")

# By text content
element = driver.find_element(By.XPATH, "//button[text()='Add Trade']")
```

### Interacting with Elements
```python
# Click
button.click()

# Type
input.send_keys("text")

# Clear and type
input.clear()
input.send_keys("new text")

# Get value
value = input.get_attribute("value")
```

### Waiting for Elements
```python
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# Wait for element to be visible
element = WebDriverWait(driver, 10).until(
    EC.visibility_of_element_located((By.ID, "my-element"))
)

# Wait for element to be clickable
button = WebDriverWait(driver, 10).until(
    EC.element_to_be_clickable((By.ID, "my-button"))
)
```

### Scrolling
```python
# Scroll to element
element = driver.find_element(By.ID, "trades")
driver.execute_script("arguments[0].scrollIntoView();", element)

# Scroll to bottom
driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")

# Scroll to top
driver.execute_script("window.scrollTo(0, 0);")
```

## Test Structure

```python
import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By

@pytest.fixture(scope="module")
def driver():
    """Start browser"""
    options = webdriver.ChromeOptions()
    driver = webdriver.Chrome(options=options)
    driver.implicitly_wait(10)
    yield driver
    driver.quit()

class TestMyFeature:
    def test_something(self, driver):
        """Test description"""
        driver.get("http://localhost:5005")
        
        # Your test steps
        # 1. Find element
        # 2. Interact with it
        # 3. Verify result
        
        assert True  # Your assertion
```

## Tips

1. **Always add delays** - Web elements take time to load
   ```python
   time.sleep(2)
   ```

2. **Use waits** - Wait for elements to be ready
   ```python
   WebDriverWait(driver, 10).until(
       EC.visibility_of_element_located((By.ID, "element"))
   )
   ```

3. **Handle errors gracefully** - Wrap risky code in try/except
   ```python
   try:
       element.click()
   except:
       # Element not available, that's ok
       pass
   ```

4. **Test locally first** - Run Flask app on localhost:5005

5. **Watch the browser** - Comment out headless mode to see what's happening
   ```python
   # In test_gui_elements.py, comment out line 18:
   # options.add_argument('--headless')
   ```

## Debugging

### See what's happening
1. Comment out `--headless` in test_gui_elements.py line 18
2. Run tests
3. Watch the browser execute your tests

### Take screenshots
```python
driver.save_screenshot("test_screenshot.png")
```

### Print page source
```python
print(driver.page_source)
```

## Running GUI Tests

```bash
# Start your Flask app first
python3 app.py

# In another terminal, run tests
PYTHONPATH=. pytest tests/gui/test_gui_elements.py -v

# Run specific test
PYTHONPATH=. pytest tests/gui/test_gui_elements.py::TestDashboard::test_page_loads -v
```
