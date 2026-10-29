# Keeping it current

The agent reads the game through tables and prompts, and when the game changes they go stale **silently**: nothing
errors, the words are simply wrong. It wrote "Pokemon Mart" into its markers because a map table said MART. It could
not use its own type chart because the bridge named types in vanilla's words. The SLATE MARK milestone never ticked
because it was still waiting for BOULDER. Each looked like the model being stupid, and each was the harness.

So the data is not kept by hand. The symbols and the name tables are written from the build and the engine's own
source by tools in the [DAEMONS](https://github.com/CodeMusic/DAEMONS) repository, and a check proves the result. The
brief is the one thing written by hand.

## The tools

All four live in DAEMONS' `tools/`, run from its root, and report without `--write`:

| tool | writes | from |
|---|---|---|
| `gbasym.py` | the symbol table the bridge reads RAM by (DAEMONS' `ai/pokefirered.sym`) | the build's ELF, on every `./bindDaemons.sh --ai` |
| `port_gamedata.py` | [`game_data_firered/mappings.json`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/game_data_firered/mappings.json) and the milestones in [`server/progress_steps.json`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/progress_steps.json) | the engine's species, move and ability names, its `items.json` and `event_objects.h`, the renamed places, and the MARK ids the bridge reports |
| `port_prompts.py` | the first pass of the prompts in [`server/prompts/`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/tree/context-content/server/prompts) into the game's words | DAEMONS' table of renames, the one its other tools use. The brief has been kept by hand past what it knows since 2026-09-26, so it now refuses a whole-tree write that would undo that |
| `check_agent_vocab.py` | nothing: it fails if a vanilla word reaches the model | see below |

`port_gamedata.py` compares the engine's tables with vanilla's copy of the same files, and only where ours differs is
a name ours; an id vanilla never had is added rather than skipped. It also rewrites a milestone's trigger along with
its label, because the trigger is a contract with the bridge: a step labelled for one map and waiting on another never
fires, and says nothing.

## The check

**`check_agent_vocab.py` renders what the model actually sees and searches it**, rather than searching the source:
half the vanilla words ever found were in generated XML tags and formatter templates that no search for `POKEMON`
would reach. It covers:

| | |
|---|---|
| the developer prompt | `game.txt`, rendered, and the other four prompts |
| the user prompt | the last one actually sent, from the run's data |
| the name tables | maps, people, species, items, moves |
| the bridge's own tables | compared against the C they read, not word-scanned -- the type names shipped vanilla for weeks because they arrived as data, not as words anyone thought to forbid |

DAEMONS runs it before every push.

## By hand: the brief

What the game has added, the brief is told in prose ([The brief](The-brief)). DAEMONS ticket T-319, *the AI playtester
knows the game as it is now*, is kept open for it, and each pass is a commit here, most of them naming the date the
brief now knows. A pass also checks that the save offsets the bridge reads have not moved in the engine's headers.

## The milestones are shared

`server/progress_steps.json` is read back by DAEMONS itself. The CHECKPOINT attendant's dreams for a player who is
stuck follow its steps, and so does the companion's planner, so the game, the companion and the playtester agree on
what comes next. A change to a step here is a change there.

## Branches

| branch | what it is |
|---|---|
| `context-content` | ours, and the default: every commit of this fork |
| `main` | Clad3815's `main`, untouched, to pull their fixes from |

DAEMONS' `./setup.sh` clones this fork with ours as `origin` and Clad3815's as `upstream`, on `context-content`, and
links it in as `engineAi/`. It is never vendored into DAEMONS.
