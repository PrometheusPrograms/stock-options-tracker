import sys
import os

# Add the project directory to Python path
project_dir = '/home/YOUR_USERNAME/stock-options-tracker'
if project_dir not in sys.path:
    sys.path.append(project_dir)

# Change to the project directory
os.chdir(project_dir)

# Set environment variables for production (PythonAnywhere)
# Note: You can also set these in the Web tab's Environment variables section
# This is useful if you want to keep them in version control (but be careful with secrets!)
os.environ['SCHWAB_REDIRECT_URI'] = 'https://prometheusprograms.pythonanywhere.com/auth/schwab/callback'
os.environ['SCHWAB_TOKEN_FILE'] = 'schwab_tokens.json'
# DO NOT put SCHWAB_APP_KEY and SCHWAB_APP_SECRET here - use Web tab instead for security

# Import the Flask app
from app import app as application

# Optional: Configure for production
if __name__ == "__main__":
    application.run()
