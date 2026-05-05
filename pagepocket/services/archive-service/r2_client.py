"""R2 client wrapper for archive service."""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
from r2_utils import R2Client
