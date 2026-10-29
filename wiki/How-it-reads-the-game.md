# How it reads the game

**It reads RAM first and the screen second.** The agent knows the exact HP of every daemon and the tile it stands on
because it read them, not because it looked. Screenshots go along with the state to cover what memory does not say: a
cutscene, a menu with no symbol behind it, whether the thing ahead looks like a door. That is why a small model is
plausible here at all.

## Four layers

Clad3815's design, unchanged in shape:

| layer | what it is | where |
|---|---|---|
| **mGBA + Lua** | runs the game; the script opens a socket for fast memory reads and button input | [`mgba/scripts/DaemonsBridgeSocketServer.lua`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/mgba/scripts/DaemonsBridgeSocketServer.lua), on 8888 and up |
| **The bridge** | reads the game out of RAM and sends inputs; FastAPI | [`firered_mgba_bridge.py`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/firered_mgba_bridge.py) and [`firered_bridge/`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/tree/context-content/firered_bridge), on 8000 |
| **The agent** | the decision loop, the model calls, the run's state | [`server/`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/tree/context-content/server), on 9885 |
| **The dashboard** | a static page that watches the agent over a WebSocket | [`frontend/`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/tree/context-content/frontend) |

The bridge answers four calls: `/requestData` (the whole state), `/minimapSnapshot` (the explored map),
`/sendCommands` (buttons) and `/restartConsole`.

## Symbols, and why ours are generated

The bridge finds the game state **by symbol name**, from a `pokefirered.sym`. The one shipped here describes retail
*FireRed*. Measured against a build of DAEMONS:

| region | symbols | agree |
|---|---|---|
| EWRAM + IWRAM -- the live state | 892 | **99.3%** |
| ROM -- static data | 48,804 | **3.8%** |

So the shipped file reads party, position and battle state correctly, and anything static in the ROM as garbage. That
is the worst failure there is, because it looks like it is working. DAEMONS' `tools/gbasym.py` writes the table from
the build's own ELF on every `--ai`, so it cannot drift from the ROM being played, and the run sets
`FIRERED_BRIDGE_STRICT_SYMBOLS=1` so a missing symbol fails loudly.

## What is read

| | |
|---|---|
| **The player** | name, CACHE (money), MARKS, map, position and elevation, walking, cycling, surfing or diving, whether DISPLACE is active, whether VERBOSE is needed or active, reduced visibility |
| **The party** | species, nickname, level, HP, ROUTINES and their PP, types, ability, held item, status, shiny, and whether a daemon is **AWAY** on a companion device |
| **Storage** | the bag by pocket, the PORT's items, and the daemons in its BOXES |
| **Battle** | both sides, wild or trainer, single or double |
| **Text and menus** | the open dialogue, and which menu is up with its options and cursor -- the START menu as two columns, each option with its column and row |
| **The map** | the tiles on screen, the explored grid, the people on the map with their names and positions, warps and map connections |
| **Story flags** | the story events the milestones track, and DAEMONS' own flags: the understandings arrived at, the instrument, the SONGBOOK by title, the weather |
| **The screen** | a screenshot, taken each turn |

## What this fork changed in the bridge

| | why |
|---|---|
| **Type names** | the bridge named types in vanilla's words while the brief used the game's, so the agent could not join its own party to its own type chart. The map is now written from the engine's `gTypeNames` |
| **DAEMONS' flags** | the game keeps its own flag array in SaveBlock2; the bridge reads the whole of it |
| **AWAY** | a daemon sent to the companion carries a bit that says so, and the bridge reports it |
| **The START menu** | DAEMONS' START menu is two columns, so UP and DOWN move within a column and LEFT and RIGHT between them |
| **A 12-bit graphics id** | the engine widened an object's graphics id past 255 without moving a byte; the bridge reads the high bits too, so the agent is told the right person |
| **Invisible objects** | left out of the list of people: what a player cannot see, the agent is not told about |

## The name tables

[`game_data_firered/mappings.json`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/game_data_firered/mappings.json)
holds the names the agent is shown, keyed by id:

| table | entries | from |
|---|---|---|
| `SPECIES_NAME` | 413 | the engine's species names |
| `MOVE_NAME` | 365 | the engine's move names |
| `ITEM_NAME` | 376 | the engine's `items.json` |
| `ABILITY_NAME` | 78 | the engine's ability names |
| `EVENT_OBJECT_NAME` | 237 | the engine's `event_objects.h`: who the agent is looking at, by the game's own name for them |
| `MAP_NAME_TABLE` | 45 groups | the map identifiers, with the renamed places substituted |

They are written by DAEMONS' `tools/port_gamedata.py`, never by hand ([Keeping it current](Keeping-it-current)).
`metatile_behaviors.json` is Clad3815's, unchanged.

## The explored map

The bridge keeps a **fog-of-war grid for each map** in `minimaps/<group>-<number>.json`, filled in as the agent sees
tiles, with undiscovered ones left blank. It is local to a machine and not in git. Each turn's prompt carries two
views of it: the tiles on screen, and the map explored so far with its exits **named** -- doors, stairs, warps, exit
carpets, the edges of an outdoor map and the connections off it, each with the way to go. The agent's own markers
come with it, and the dashboard draws them on its minimap.

## The screen

Each turn the screenshot is scaled up three times. In the overworld a second copy has the tile grid drawn over it:
each tile outlined in a colour for its kind and labelled with its map coordinates. Both go to the model, and the
history keeps the last `DAEMONS_KEEP_IMAGES` turns of them (two by default; images are the expensive half of a
prompt). The scaled screen is also written into `frontend/` as the dashboard's frames.

## An open question

An agent reading RAM has information a player never gets: exact HP, exact matchups, the whole chart. The game spends a
good deal of itself on whether a person can work the chart out from names and colour. A model that reads the
multiplier directly is playing a different game, in the sense the game is about. Feeding it only what a player could
see would be the more interesting experiment, and it has not been done.
