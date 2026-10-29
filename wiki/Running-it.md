# Running it

## What it needs

| | |
|---|---|
| **mGBA** | 0.10 or newer, with its scripting window (**Tools -> Scripting**). 0.10.5 has no `--script`, so loading the Lua script is one step by hand |
| **A DAEMONS ROM** | the CONTENT edition, built from [pokefirered-daemons](https://github.com/CodeMusic/pokefirered-daemons), and a symbol table made from the same build ([How it reads the game](How-it-reads-the-game)) |
| **Python 3.10+** | the bridge: `fastapi`, `uvicorn`, `pydantic`, `python-dotenv`, `requests` ([`requirements.txt`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/requirements.txt)) |
| **Node 18+** | the agent, in `server/` |
| **A model** | an endpoint that speaks OpenAI's Responses API, or LiteLLM in front of one that does not ([Local and open models](Local-and-open-models)) |

The symbol table is the part that needs a build: the `pokefirered.sym` shipped here describes retail *FireRed*, and
against DAEMONS it reads RAM correctly and the ROM's static data as garbage. So the practical way to run this is from a
DAEMONS checkout, which builds the ROM and its symbols together.

## From DAEMONS: `./bindDaemons.sh --ai`

In a [DAEMONS](https://github.com/CodeMusic/DAEMONS) checkout, `./setup.sh` clones this fork beside it and links it in
as `engineAi/`. Then:

```sh
./bindDaemons.sh --ai                  # build CONTENT and play it, resuming the last run
./bindDaemons.sh --ai --fresh          # the same, with the agent's history cleared
./bindDaemons.sh --ai --model NAME     # another model from DAEMONS' LiteLLM config
./bindDaemons.sh --ai --simple-schema  # eight tools instead of eleven
./bindDaemons.sh --ai --nested-tools   # upstream's single execute_action tool
./bindDaemons.sh --stop                # stop the bridge, the agent, the dashboard and mGBA
```

What `--ai` does, in order:

1. builds CONTENT and opens it in mGBA
2. writes `ai/pokefirered.sym` from that build's ELF (DAEMONS' `tools/gbasym.py`), points `FIRERED_SYM_PATH` at it,
   and sets `FIRERED_BRIDGE_STRICT_SYMBOLS=1` so a missing symbol fails instead of reading zeroes
3. finds the LiteLLM proxy and reads its key from the machine it runs on -- the key is never stored in either repo
4. sets the run's knobs ([Configuration](Configuration))
5. makes the bridge its own venv once (`ai/bridgevenv/`) and checks its imports before starting anything
6. stops a previous run if one is still up, and waits for its ports to be released
7. starts the bridge, the agent and the dashboard (on port 5173), with their logs in DAEMONS' `ai/logs/`
8. prints the one line to paste into mGBA, resolved to this machine's path

**Ctrl+C does not end a run.** The bridge and the agent are started by the script and outlive it. `--stop` ends them,
and `--ai` calls it for you when a previous run is still up.

## The one step by hand: the Lua script

**Tools -> Scripting** opens a window whose only obvious control is a text box with a **Run** button. **That box is a
Lua REPL, not a file picker.** A path typed into it fails with `unexpected symbol near '~'`. Paste this instead and
press Run -- with an absolute path, because Lua does not expand `~`:

```lua
dofile("/ABSOLUTE/PATH/TO/mgba/scripts/DaemonsBridgeSocketServer.lua")
```

Or use **File -> Load script...**, which on macOS is in the screen's menu bar while the Scripting window is focused.
The window reports the socket server listening on port 8888 (or the next free one). The script lives as long as the
emulator does, so the window can be closed afterwards. Once per mGBA launch, and `--ai` relaunches mGBA every time.

## By hand, without DAEMONS

Clad3815's own steps still work ([README](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons#readme)), with
two things added: a symbol table for your build, and a model endpoint.

```sh
python -m pip install -r requirements.txt
(cd server && npm ci)
cp .env.example .env                 # the bridge: set FIRERED_SYM_PATH to your build's .sym
cp server/.env.example server/.env   # the agent: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

Then start them in this order:

| | | |
|---|---|---|
| 1 | mGBA with the ROM, and the Lua script loaded | listens on 8888 and up |
| 2 | `python firered_mgba_bridge.py` | the bridge, on 8000 |
| 3 | `cd server && npm start` | the agent, HTTP and WebSocket on 9885 |
| 4 | `cd frontend && python -m http.server 5173` | the dashboard, at `http://localhost:5173` |

## Resuming, and `--fresh`

**A restart is a resume.** The agent keeps its state in `server/gpt_data/` -- history, memory, objectives, markers,
summaries, the self-model, dreams, feelings, asides, playtest notes -- and loads it again on start. `--ai` says how much
history it is resuming.

**`--fresh` clears the agent, not the save.** It moves `server/gpt_data/` aside to `server/gpt_data_<date>-<time>/` and
keeps the newest five of those (`DAEMONS_KEEP_RUNS`; 0 keeps them all). If the game is mid-run, the agent wakes there
with no notes, and its prompt says so: it is told its objectives may be stale and to work out where it is first.

## When it will not start

| What you see | What to check |
|---|---|
| the agent logs `ECONNREFUSED` on :8000 | the bridge crashed: read `ai/logs/bridge.log` (a missing Python module kills it on import) |
| the bridge reports `403 Forbidden` | mGBA is not running, or the Lua script was not loaded: the bridge fell back to mGBA's HTTP interface and nothing answered |
| unsure which | `lsof -nP -iTCP:8888 -sTCP:LISTEN` -- if mGBA holds 8888, the script is running |
| the first model call 404s | the endpoint does not serve `/v1/responses` ([Local and open models](Local-and-open-models)) |
| a new bridge dies on bind | a previous run still holds :8000: `./bindDaemons.sh --stop` |
