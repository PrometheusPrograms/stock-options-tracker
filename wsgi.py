import sys
import os

project_dir = os.path.dirname(os.path.abspath(__file__))
if project_dir not in sys.path:
    sys.path.insert(0, project_dir)

os.chdir(project_dir)

# env_config runs inside app.py on import — no duplicate logic needed here
from app import app as application

if __name__ == '__main__':
    application.run()
