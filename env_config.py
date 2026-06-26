"""
Environment configuration for local dev vs PythonAnywhere accounts.
"""
import os
from typing import Optional

# Known PythonAnywhere accounts → forced settings (override .env defaults)
PA_CONFIGS = {
    'greenmangroup': {
        'APP_ENV': 'production',
        'DB_PATH': '/home/greenmangroup/inv_track/trades.db',
        'SCHWAB_REDIRECT_URI': 'https://greenmangroup.pythonanywhere.com/auth/schwab/callback',
        'SCHWAB_TOKEN_FILE': '/home/greenmangroup/inv_track/schwab_tokens.json',
    },
    'greenmandev': {
        'APP_ENV': 'test',
        'DB_PATH': '/home/greenmandev/inv_track/trades_test.db',
        'SCHWAB_REDIRECT_URI': 'https://greenmandev.pythonanywhere.com/auth/schwab/callback',
        'SCHWAB_TOKEN_FILE': '/home/greenmandev/inv_track/schwab_tokens.json',
    },
}


def get_pa_username() -> Optional[str]:
    home = os.path.expanduser('~')
    if not home.startswith('/home/'):
        return None
    return os.path.basename(home.rstrip('/'))


def configure_environment() -> Optional[str]:
    """
    Apply environment-specific settings.
    On known PA accounts, force override so stale .env values can't leak through.
    Returns the PA username if matched, else None.
    """
    pa_user = get_pa_username()
    if pa_user not in PA_CONFIGS:
        return None

    for key, value in PA_CONFIGS[pa_user].items():
        os.environ[key] = value

    return pa_user
