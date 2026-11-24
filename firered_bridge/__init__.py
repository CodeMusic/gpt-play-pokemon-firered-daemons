# BRAIN: none -- the game's state read out of RAM; its parsers get no lines
"""FireRed mGBA bridge helper package."""

from . import game_state, mgba_client, game_data

__all__ = ["game_state", "mgba_client", "game_data"]
