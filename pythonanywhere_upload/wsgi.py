import sys
import os

# Add the project directory to Python path
project_dir = '/home/YOUR_USERNAME/stock-options-tracker'
if project_dir not in sys.path:
    sys.path.append(project_dir)

# Change to the project directory
os.chdir(project_dir)

# Import the Flask app
from app import app as application

# Optional: Configure for production
if __name__ == "__main__":
    application.run()
