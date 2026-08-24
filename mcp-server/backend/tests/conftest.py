'''
Test import setup for the standalone MCP backend.

This file was written with AI assistance.
'''

from __future__ import annotations

from pathlib import Path
import sys


MCP_SERVER_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(MCP_SERVER_ROOT))
