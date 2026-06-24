import sys
import os

project_dir = os.path.dirname(os.path.abspath(__file__))
if project_dir not in sys.path:
    sys.path.insert(0, project_dir)

os.chdir(project_dir)

# ── Auto-detect environment from the PythonAnywhere username ─────────────────
# This lets both sites share the exact same wsgi.py from the same git repo.
pa_username = os.path.basename(os.path.expanduser('~'))  # e.g. "greenmandev" or "greenmangroup"

if pa_username == 'greenmangroup':
    # ── PRODUCTION ────────────────────────────────────────────────────────────
    os.environ.setdefault('APP_ENV',            'production')
    os.environ.setdefault('DB_PATH',            f'/home/greenmangroup/inv_track/trades.db')
    os.environ.setdefault('SCHWAB_REDIRECT_URI','https://greenmangroup.pythonanywhere.com/auth/schwab/callback')
    os.environ.setdefault('SCHWAB_TOKEN_FILE',  f'/home/greenmangroup/inv_track/schwab_tokens.json')

elif pa_username == 'greenmandev':
    # ── TEST / STAGING ────────────────────────────────────────────────────────
    os.environ.setdefault('APP_ENV',            'test')
    os.environ.setdefault('DB_PATH',            f'/home/greenmandev/inv_track/trades_test.db')
    os.environ.setdefault('SCHWAB_REDIRECT_URI','https://greenmandev.pythonanywhere.com/auth/schwab/callback')
    os.environ.setdefault('SCHWAB_TOKEN_FILE',  f'/home/greenmandev/inv_track/schwab_tokens.json')

else:
    # ── LOCAL DEVELOPMENT ─────────────────────────────────────────────────────
    os.environ.setdefault('APP_ENV',            'development')
    os.environ.setdefault('DB_PATH',            os.path.join(project_dir, 'trades.db'))
    os.environ.setdefault('SCHWAB_REDIRECT_URI','http://localhost:5005/auth/schwab/callback')
    os.environ.setdefault('SCHWAB_TOKEN_FILE',  os.path.join(project_dir, 'schwab_tokens.json'))

# SCHWAB_APP_KEY and SCHWAB_APP_SECRET must still be set manually on each server
# (never commit secrets to git). On PythonAnywhere free plan, add them directly
# in wsgi.py but keep this file out of public repos:
#   os.environ.setdefault('SCHWAB_APP_KEY',    'your_key_here')
#   os.environ.setdefault('SCHWAB_APP_SECRET', 'your_secret_here')

from app import app as application

if __name__ == '__main__':
    application.run()
