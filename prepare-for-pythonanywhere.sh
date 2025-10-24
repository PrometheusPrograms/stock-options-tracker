#!/bin/bash

echo "🚀 Preparing files for PythonAnywhere upload..."
echo "=============================================="

# Create upload directory
mkdir -p pythonanywhere_upload/templates
mkdir -p pythonanywhere_upload/static/css
mkdir -p pythonanywhere_upload/static/js

# Copy main files
cp app.py pythonanywhere_upload/
cp requirements-pythonanywhere.txt pythonanywhere_upload/requirements.txt
cp wsgi.py pythonanywhere_upload/

# Copy templates
cp templates/index.html pythonanywhere_upload/templates/

# Copy static files
cp static/css/style.css pythonanywhere_upload/static/css/
cp static/js/app.js pythonanywhere_upload/static/js/

echo "✅ Files prepared in 'pythonanywhere_upload' directory"
echo ""
echo "📁 Upload these files to PythonAnywhere:"
echo "1. Upload pythonanywhere_upload/app.py to /home/YOUR_USERNAME/"
echo "2. Upload pythonanywhere_upload/requirements.txt to /home/YOUR_USERNAME/"
echo "3. Upload pythonanywhere_upload/wsgi.py to /home/YOUR_USERNAME/"
echo "4. Upload pythonanywhere_upload/templates/index.html to /home/YOUR_USERNAME/templates/"
echo "5. Upload pythonanywhere_upload/static/css/style.css to /home/YOUR_USERNAME/static/css/"
echo "6. Upload pythonanywhere_upload/static/js/app.js to /home/YOUR_USERNAME/static/js/"
echo ""
echo "🔧 Then follow the PythonAnywhere deployment steps!"
