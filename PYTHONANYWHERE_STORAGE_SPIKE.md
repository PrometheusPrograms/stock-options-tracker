# PythonAnywhere Storage Spike During Deployment

## Why Storage Spikes to 70% During Push

When you push to PythonAnywhere, the storage temporarily spikes to 70% and then drops back to 40% after deployment finishes. This is caused by temporary files created during the deployment process.

## What Causes the Spike

### 1. **Git Operations** (During `git pull` / `git fetch`)
- **`.git/objects/`**: Git downloads new objects (commits, trees, blobs) from the remote repository
- **`.git/refs/`**: Reference files are updated
- **`.git/index`**: Index file is rebuilt
- **Temporary merge/rebase files**: Created during merge operations
- **Size**: Can be 10-30% of your total storage temporarily

### 2. **Package Installation** (During `pip3 install --user`)
- **Download cache**: Pip downloads packages to `~/.cache/pip/` before installation
- **Wheel files**: Packages are extracted and built as wheels
- **Temporary build files**: Created during package compilation
- **Size**: Can be 20-40% of your total storage temporarily (especially for large packages like pandas, numpy)

### 3. **Python Bytecode** (During app startup)
- **`__pycache__/`**: Python creates `.pyc` files when modules are imported
- **Size**: Usually small (1-5%), but accumulates over time

### 4. **Log Files** (During deployment)
- **`flask_debug.log`**: Logs written during deployment
- **`flask_output.log`**: Output logs
- **Size**: Usually small, but can grow

## Why It Drops Back to 40%

After deployment finishes:
- ✅ **Git cleans up**: Temporary objects are garbage collected
- ✅ **Pip cleans up**: Downloaded packages are removed after installation
- ✅ **Build files removed**: Temporary build files are deleted
- ❌ **`.pyc` files remain**: Python bytecode files stay (but are small)

## How to Reduce the Spike

### 1. **Clean Git Repository**
```bash
# On PythonAnywhere, run periodically:
cd /home/YOUR_USERNAME/stock-options-tracker
git gc --aggressive --prune=now
```

### 2. **Clean Pip Cache**
```bash
# Clear pip cache to free up space:
pip3 cache purge
```

### 3. **Clean Python Bytecode**
```bash
# Remove all .pyc files:
find . -type d -name __pycache__ -exec rm -r {} +
find . -name "*.pyc" -delete
```

### 4. **Optimize Deployment Script**
Add cleanup steps to your deployment script:

```bash
# After git pull and pip install:
git gc --prune=now
pip3 cache purge
find . -type d -name __pycache__ -exec rm -r {} + 2>/dev/null || true
```

### 5. **Use `--no-cache-dir` for Pip** (Not Recommended)
```bash
# This prevents caching but makes installs slower:
pip3 install --user --no-cache-dir -r requirements.txt
```

## Monitoring Storage

### Check Current Storage Usage
```bash
# On PythonAnywhere console:
du -sh ~
du -sh ~/.cache
du -sh ~/.local/lib/python3.*/site-packages
du -sh ~/stock-options-tracker/.git
```

### Find Large Files
```bash
# Find files larger than 10MB:
find ~ -type f -size +10M -exec ls -lh {} \;
```

## Best Practices

1. **Run `git gc` periodically**: Clean up Git objects
2. **Clear pip cache monthly**: `pip3 cache purge`
3. **Monitor storage**: Check storage usage regularly
4. **Clean up logs**: Remove old log files
5. **Don't commit large files**: Keep `.gitignore` updated

## Expected Behavior

- **During deployment**: Storage spikes to 60-70% (temporary)
- **After deployment**: Storage drops to 40-45% (normal)
- **This is normal**: The spike is temporary and expected

## If Storage Stays High

If storage doesn't drop after deployment:

1. **Check for large files**:
   ```bash
   du -sh ~/* | sort -h
   ```

2. **Check Git repository size**:
   ```bash
   du -sh ~/stock-options-tracker/.git
   ```

3. **Check pip cache**:
   ```bash
   du -sh ~/.cache/pip
   ```

4. **Check Python packages**:
   ```bash
   du -sh ~/.local/lib/python3.*/site-packages
   ```

5. **Clean up manually**:
   ```bash
   git gc --aggressive --prune=now
   pip3 cache purge
   find ~/stock-options-tracker -type d -name __pycache__ -exec rm -r {} +
   ```







