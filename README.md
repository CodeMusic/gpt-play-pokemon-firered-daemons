# gpt-play-pokemon-firered-daemons

> **A fork of [Clad3815/gpt-play-pokemon-firered][up], pointed at a different
> game and at models that are not frontier ones.** All the hard parts — the
> mGBA Lua bridge, the RAM reader, the agent loop, the dashboard — are
> Clad3815's. Their README is kept in full below.

[up]: https://github.com/Clad3815/gpt-play-pokemon-firered

This fork drives **DAEMONS: CONTEXT / CONTENT**, a total conversion of FireRed
where the creatures are daemons and the type chart is an argument about
consciousness.

**[The wiki](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/wiki)**
covers every feature: running it, how it reads the game, the agent loop, its
inner life, playtesting, the dashboard and what the agent is told about the
game. New to DAEMONS itself? **[The player's manual](https://github.com/CodeMusic/DAEMONS/blob/main/docs/DAEMONS-manual.pdf)**
(PDF) tells how to play it.

| | |
|---|---|
| the game | [CodeMusic/DAEMONS](https://github.com/CodeMusic/DAEMONS) ([wiki](https://github.com/CodeMusic/DAEMONS/wiki)) — the design, the tools, the releases, and `./bindDaemons.sh --ai` |
| the engine | [CodeMusic/pokefirered-daemons](https://github.com/CodeMusic/pokefirered-daemons) ([wiki](https://github.com/CodeMusic/pokefirered-daemons/wiki)) — the ROM this plays |
| the companion | [CodeMusic/daemons-companion](https://github.com/CodeMusic/daemons-companion) ([wiki](https://github.com/CodeMusic/daemons-companion/wiki)) |
| the playground | [CodeMusic/daemons-playground](https://github.com/CodeMusic/daemons-playground) ([wiki](https://github.com/CodeMusic/daemons-playground/wiki)) |
| this | the harness that lets a model play it ([wiki](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/wiki)) |

![The dashboard: runtime, inner life, user and frames across the top; tabs for
summary, party, inventory, objectives, progress and memory below.](docs/screenshots/dashboard.png)

*The dashboard during a September 2026 run. The Playtest tab, the Backchannel
panel and the pause button came after it.*

## Where it stands

As of 2026-10-28:

- **Built, and played.** It ran through September 2026 against local models
  (LM Studio, mlx-vlm) and hosted open ones through OpenRouter; the longest run
  went past step 1,100.
- **Kept current since, not re-run.** The game's changes since then have
  reached the brief, the bridge and the name tables a piece at a time (DAEMONS
  T-319), checked against the engine's source and by DAEMONS' vocabulary check.
  The most recent run on record is from mid-September.
- **Planned.** A longer playtest run, whose notes are then read and triaged, is
  decided and not yet made.

## What is different here

**It started as one line.** The client was `new OpenAI({ apiKey })` with no
`baseURL`, so it could only ever reach OpenAI. It takes `OPENAI_BASE_URL` now,
falling back to `api.openai.com` exactly as before when unset.

It did not stay one line. **152 commits, about 10,700 lines added across 44
files**, in four directions: making the loop survive a model that is not GPT-5,
giving the run an interior, making it a playtester, and teaching it DAEMONS.

### Running against a local or open model

| | why |
|---|---|
| `server/src/ai/localPath.js` | **BFS pathfinding in-process.** Upstream calls OpenAI's Code Interpreter to plan a route. Reading the game's own tile grid needs no model at all, and unlike the rules we hand-wrote it has never needed revising. |
| `server/src/ai/salvageToolCall.js` | **Recovers tool calls the server throws away.** MiniCPM's calls arrive in an XML dialect mlx-vlm's parser drops when the JSON inside is imperfect; this parses them back out. 25/25 on real failures. |
| flat tools | **One tool per action**, not upstream's single `execute_action`: through the union qwen3-vl-8b emitted 27 duplicate calls in one response, as separate tools one. |
| a ceiling on a turn | `DAEMONS_MAX_OUTPUT_TOKENS`, no SDK retries, two turns of screenshots rather than ten, and only the last two reasoning items replayed — each measured on a local model. |
| `server/src/core/progress.js` | A **score** from badges, maps, levels, daemons bound and money — so "is it getting anywhere" has an answer that is not a vibe. |
| `server/src/core/trajectory.js` | What the last 40 steps actually *did*, counted. Self-critique was asked to spot loops while being shown a single screen; this is the half it was missing. |
| the loop guard | A repeated move that went nowhere is refused, or taken back out of the history, so the model is not outvoted by its own mistakes. |
| history folding | The summariser could fail forever without advancing, and the history it failed to fold grew to 12.4 MB and timed out every call. Three strikes, then a mechanical trim. |

### An interior

The agent has a **voice**, and three layers behind it that make the voice
somebody's rather than nobody's:

| | what it is | written when |
|---|---|---|
| `aside` | one or two sentences of inner thought, per turn | every action |
| `server/src/core/feelings.js` | four **humor axes** — GLAD, MAD, SAD, and CALM↔AFRAID — plus a boredom drive. Derived from what happens, decaying toward nothing | every turn |
| `<self>` | what it has noticed about **how it plays** | when it reflects |
| `server/src/core/dream.js` | what the summariser threw away, written back as images | at every fold |

None of it is asked of the model as a self-report. The feelings come off the
same snapshot the score does; the trajectory comes off the history. Every time
this fork has let a model assert something about itself, the value drifted.

Any line of inner voice — or any dream — can be **spoken aloud** in the INDEX
voice, through an n8n workflow in the DAEMONS repo. Click the ▶.

### A playtester, and a way to reach it

| | what it is |
|---|---|
| `server/src/core/playtest.js` | notes on the game as a place — **LIKED, DISLIKED, CONFUSED** — asked for on first arrival at a map, kept for the people building the game and never returned to the agent |
| `server/src/core/backchannel.js` | a line typed into the dashboard reaches the agent once, from nowhere it can check; `consult` lets it ask one question back, which may or may not be answered |
| **Pause agent** | a person takes the controls; when they are handed back the agent is told that what changed was not its doing, and to draw no lesson from it |

### Knowing the game

The brief, [`server/prompts/game.txt`](server/prompts/game.txt), knows DAEMONS
as of 2026-10-28 and is kept current with it (DAEMONS T-319). The name tables in
[`game_data_firered/mappings.json`](game_data_firered/mappings.json) are written
from the engine's own source by DAEMONS' `tools/port_gamedata.py`, so the agent
is told who it is looking at in the game's own words. The bridge reads the
game's type names, its own flags (the understandings, the SONGBOOK, the
weather), a daemon that is AWAY, the two-column START menu and the engine's
wider graphics ids. DAEMONS' `tools/check_agent_vocab.py` renders what the
model sees and fails if a vanilla word reaches it.

**[docs/WHAT-THIS-FORK-ADDS.md](docs/WHAT-THIS-FORK-ADDS.md)** goes through the
first two directions properly — every module, why it exists, what it replaced,
and the configuration. Including the pattern most of these bugs turned out to
share. The [wiki](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/wiki)
has all four.

**The rest is configuration**, and it lives in the DAEMONS repo:
`./bindDaemons.sh --ai` builds the ROM, regenerates the symbol table from that
build, finds the model proxy, reads its key, and starts the bridge, the agent
and the dashboard.

## If you are trying this against a local model, read this first

**It is not one environment variable.** The call sites use
`openai.responses.create()` — the **Responses API** — with `input:` rather than
`messages:`, plus `reasoning: {effort, summary}`, `service_tier`, `store: true`
and `stream: true` consumed as typed events. LM Studio, llama.cpp and Ollama
serve `/v1/chat/completions` and **not** `/v1/responses`, so a base URL alone
404s on the first call.

What works is **LiteLLM proxy** in front, with two settings that are easy to
miss:

```yaml
litellm_params:
  use_chat_completions_api: true   # opt-in per model. Without it LiteLLM
                                   # forwards /v1/responses straight through
                                   # into the 404 the proxy exists to avoid.
litellm_settings:
  drop_params: true                # service_tier, store, reasoning.summary
```

Verified including streaming: the full `response.created` → `in_progress` →
`output_item.added` → `content_part.added` → `output_text` → `completed`
sequence arrives intact through the bridge.

## Symbols, and why ours are generated

The harness resolves game state **by symbol name** from a `pokefirered.sym`,
and its loader honours `FIRERED_SYM_PATH`. The one it ships describes retail
FireRed. Measured against a build of our ROM:

| region | symbols | agree |
|---|---|---|
| EWRAM + IWRAM — live state | 892 | **99.3%** |
| ROM — static data | 48,804 | **3.8%** |

So the shipped file against a modified ROM reads party, position and battle
state **correctly**, and move names, item names and the type chart as garbage.
That is the worst failure available: it looks like it is working.
`tools/gbasym.py` in the DAEMONS repo emits ours from the ELF on every run.

## Loading the Lua bridge

mGBA **0.10.5 has no `--script`** — that arrived in 0.11 — so this step is
manual, and there is one trap in it.

**Tools → Scripting** opens a window whose only obvious control is a text box
with a **Run** button. ***That box is a Lua REPL, not a file picker.*** Typing a
path into it gets `[ERROR] prompt:1: unexpected symbol near '~'`, because `~`
is not a Lua token. Two ways through:

**Paste this, and press Run** — the reliable one, and note Lua does not expand
`~`, so it must be an absolute path:

```lua
dofile("/ABSOLUTE/PATH/TO/mgba/scripts/DaemonsBridgeSocketServer.lua")
```

`./bindDaemons.sh --ai` prints the exact line, resolved through the symlink.

**Or use the menu**, which on macOS is in the screen's menu bar rather than in
the window: with the Scripting window focused, **File → Load script…**

Either way the scripting window reports the socket server starting. The script
lives as long as the emulator does, not as long as the window, so the window
can be closed once it is running. If the agent logs connection refused, this is
the step that was missed — or the bridge itself crashed
([Running it](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/wiki/Running-it)).

---

*Everything below is Clad3815's original README. One thing in it has changed:
the Lua script it names is now `DaemonsBridgeSocketServer.lua`, renamed from
`FireRedBridgeSocketServer.lua`.*

---

# GPT Plays Pokemon FireRed

> An autonomous AI agent that plays Pokemon FireRed in real time, powered by OpenAI's LLM — with a live web dashboard for monitoring.

---

## Overview

This project connects a large language model (LLM) to a running instance of **Pokemon FireRed** through a multi-layered architecture:

| Layer | Component | Role |
|-------|-----------|------|
| **Emulator** | mGBA + Lua script | Runs the game and exposes a socket bridge |
| **Bridge** | `firered_mgba_bridge.py` (FastAPI) | Reads game memory and sends inputs to the emulator |
| **Agent** | `server/index.js` (Node.js) | Runs the AI decision loop, chooses actions, manages state |
| **Dashboard** | `frontend/` (HTML/CSS/JS) | Live monitoring UI — logs, minimap, inventory, team, objectives |

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Python | 3.10+ |
| Node.js | 18+ |
| mGBA | With Lua scripting support enabled |
| Pokemon FireRed ROM | `.gba` file (not included) |
| OpenAI API key | Set as `OPENAI_API_KEY` |

### ROM Compatibility

The harness is currently compatible only with the **Pokemon - FireRed Version (USA)** ROM.

- Expected ROM MD5: `e26ee0d44e809351c8ce2d73c7400cdd`

---

## Project Structure

```
├── firered_mgba_bridge.py      # FastAPI bridge — reads game state, sends commands
├── firered_bridge/             # Memory reading logic, game state, minimap, fog of war
├── mgba/scripts/
│   └── DaemonsBridgeSocketServer.lua  # Lua script to load inside mGBA
├── server/                     # AI agent loop + WebSocket + runtime persistence
│   └── prompts/                # Prompts used by the AI agent
├── frontend/                   # Static HTML/CSS/JS monitoring dashboard
├── .env.example                # Environment template (bridge / mGBA)
└── server/.env.example         # Environment template (agent / OpenAI)
```

---

## Getting Started

### 1. Clone the repository

```bash
git clone <repo-url>
cd gpt-play-pokemon-firered
```

If you use the `pokefirered` submodule:

```bash
git submodule update --init --recursive
```

### 2. Create environment files

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
cp .env.example .env
cp server/.env.example server/.env
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
Copy-Item .env.example .env
Copy-Item server/.env.example server/.env
```

</details>

### 3. Fill in the environment variables

**`server/.env`** (required):

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | Your OpenAI API key | *(required)* |
| `PYTHON_BASE_URL` | Bridge API URL | `http://127.0.0.1:8000` |
| `WS_PORT` | WebSocket port for the dashboard | `9885` |

**`.env`** (root — bridge & mGBA):

| Variable | Description | Default |
|----------|-------------|---------|
| `MGBA_TRANSPORT` | Transport mode | `socket` *(recommended)* |
| `MGBA_SOCKET_HOST` | mGBA socket host | `127.0.0.1` |
| `MGBA_SOCKET_PORT` | Starting port for mGBA socket | `8888` |
| `MGBA_SOCKET_PORT_MAX` | Max port to scan | `8896` |
| `FIRERED_GAME_DATA_DIR` | Game data directory | `game_data_firered` |
| `FIRERED_MINIMAPS_DIR` | Minimap output directory | `minimaps` |
| `FIRERED_SCREENSHOT_DIR` | Screenshot output directory | `tmp_screenshots` |

> **Note:** The Lua script in mGBA starts listening on port `8888` and increments if the port is busy. The Python bridge scans the range `MGBA_SOCKET_PORT` → `MGBA_SOCKET_PORT_MAX`. If mGBA listens outside this range, the connection will fail.

### 4. Install dependencies

From the project root:

```bash
python -m pip install -r requirements.txt
cd server && npm install && cd ..
```

---

## Running the Project

> **Important:** Components must be started **in this exact order**.

### Step 1 — Start mGBA + Lua script

1. Open **mGBA**
2. Load the **FireRed ROM**
3. Open the **Lua scripting window** (`Tools → Scripting`)
4. Load `mgba/scripts/DaemonsBridgeSocketServer.lua`
5. Keep the script running

You should see a log message indicating the listening port (e.g. `Listening on port 8888`).

### Step 2 — Start the Python bridge

The bridge auto-loads the root `.env` file via `python-dotenv`.

```bash
python firered_mgba_bridge.py
```

The FastAPI server runs at `http://127.0.0.1:8000` by default and exposes:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/requestData` | GET | Fetch current game state |
| `/minimapSnapshot` | GET | Get the current minimap image |
| `/sendCommands` | POST | Send button inputs to the game |
| `/restartConsole` | POST | Restart the emulator bridge |

### Step 3 — Start the Node.js agent server

```bash
cd server
npm start
```

The server runs at `http://127.0.0.1:9885` (HTTP + WebSocket).

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |

For development with auto-reload:

```bash
npm run dev
```

### Step 4 — Open the dashboard *(optional but recommended)*

```bash
cd frontend
python -m http.server 5173
```

Then open **http://127.0.0.1:5173** in your browser.

The dashboard connects to WebSocket on port `9885` of the current hostname by default.

---

## Quick Health Check

Once everything is running, verify each layer:

| # | Component | How to verify |
|---|-----------|---------------|
| 1 | **mGBA + Lua** | Script is loaded, no socket errors in the Lua console |
| 2 | **Python bridge** | `GET http://127.0.0.1:8000/requestData` returns `{"ok": true, ...}` |
| 3 | **Node.js agent** | `GET http://127.0.0.1:9885/health` returns `{"ok": true, ...}` |
| 4 | **Dashboard** | Click **Connect** → logs and game state stream in via WebSocket |

---

## Environment Variables Reference

<details>
<summary><strong>Root <code>.env</code> — Python bridge / mGBA</strong></summary>

**Socket transport:**
- `MGBA_TRANSPORT` — `socket` *(recommended)* or `http`
- `MGBA_SOCKET_HOST`, `MGBA_SOCKET_PORT`, `MGBA_SOCKET_PORT_MAX`, `MGBA_SOCKET_TIMEOUT`

**HTTP transport (alternative):**
- `MGBA_API_URL`, `MGBA_HTTP_TIMEOUT`, `MGBA_READ_RANGE_CHUNK`

**Game data:**
- `FIRERED_GAME_DATA_DIR`, `FIRERED_MINIMAPS_DIR`, `FIRERED_SCREENSHOT_DIR`

**Savestate backups:**
- `FIRERED_SAVESTATE_BACKUP_*`

**Debug / advanced:**
- `FIRERED_SYM_PATH`, `FIRERED_BRIDGE_STRICT_SYMBOLS`, `FIRERED_BRIDGE_DEBUG_SAVE_INFO`
- `FIRERED_BENCHMARK`

</details>

<details>
<summary><strong><code>server/.env</code> — Node.js agent / OpenAI</strong></summary>

**Server:**
- `WS_PORT` — WebSocket port
- `PYTHON_BASE_URL` — Bridge API URL

**OpenAI:**
- `OPENAI_API_KEY` — API key *(required)*
- `OPENAI_MODEL`, `OPENAI_MODEL_PATHFINDING` — Model selection
- `OPENAI_REASONING_EFFORT*` — Reasoning effort settings
- `OPENAI_TOKEN_LIMIT`, `OPENAI_TIMEOUT_MS` — Limits
- `OPENAI_SERVICE_TIER*` — Service tier settings

</details>

---

## Runtime Data

The project generates the following files and directories during execution:

| Path | Contents |
|------|----------|
| `tmp_screenshots/` | In-game screenshots |
| `minimaps/` | Generated minimap images |
| `backup_saves/` | Automatic savestate backups |
| `server/gpt_data/` | AI agent persistent state (see below) |

**`server/gpt_data/` contents:**

- `history.json` — Conversation / action history
- `memory.json` — Agent long-term memory
- `objectives.json` — Current goals and objectives
- `markers.json` — Map markers set by the agent
- `counters.json` — Internal counters
- `summaries.json`, `all_summaries.json` — Session summaries
- `progress_steps.json` — Game progress tracking
- `map_visits.json` — Map visit log
- `badges_log.json` — Badge acquisition log
- `token_usage.json`, `time_usage.json` — Usage statistics
- `last_criticism.txt` — Latest self-critique

---

## Troubleshooting

<details>
<summary><strong>Python bridge can't connect to mGBA</strong></summary>

- Make sure the **Lua script is loaded and running** in mGBA
- Check the port range: `MGBA_SOCKET_PORT` → `MGBA_SOCKET_PORT_MAX` must cover the port mGBA is listening on
- Verify both processes are on the **same machine / network**

</details>

<details>
<summary><strong>Node.js agent keeps failing on Python calls</strong></summary>

- Confirm the Python bridge is running at the URL set in `PYTHON_BASE_URL`
- Test manually: `curl http://127.0.0.1:8000/requestData`

</details>

<details>
<summary><strong>Dashboard shows nothing</strong></summary>

- Check the **host and port** in the dashboard UI
- Make sure `WS_PORT` matches the Node.js server port
- Open the **browser console** and look for WebSocket errors

</details>

<details>
<summary><strong>OpenAI errors</strong></summary>

- Verify `OPENAI_API_KEY` is set correctly in `server/.env`
- **Restart the Node.js server** after any `.env` change

</details>

---

## Best Practices

- **Never commit** `.env` or `server/.env` — they contain secrets
- **Back up saves externally** if you want persistent savestate backups
- **Keep all components running on stable versions** during long play sessions to avoid mid-run breakage

---

## License

This project is licensed under **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**.

- Forking and modifications are allowed.
- Commercial use is not allowed.
- Attribution is required (credit this repository and link to the original source when reusing code).

See [LICENSE](LICENSE) for details.
