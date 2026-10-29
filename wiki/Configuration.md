# Configuration

Everything is an environment variable. The agent reads `server/.env`, the bridge reads the root `.env`, and
`./bindDaemons.sh --ai` in DAEMONS sets the ones a run needs. Each default here is the harness's own, and leaves it
behaving as Clad3815's did where the variable is theirs. The examples are
[`server/.env.example`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/.env.example)
and [`.env.example`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/.env.example);
the agent's are read in
[`server/src/config.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/config.js).

## The model

| variable | default | `--ai` sets | what it does |
|---|---|---|---|
| `OPENAI_BASE_URL` | unset: OpenAI itself | the LiteLLM proxy | where every model call goes |
| `OPENAI_API_KEY` | none | the proxy's key, read where it lives | sent as the bearer token |
| `OPENAI_MODEL` | `gpt-5.2` | the `--model` name | the model that plays, summarises and critiques |
| `OPENAI_MODEL_PATHFINDING` | `gpt-5.2` | a pathfinding entry | used only by upstream's pathfinder (`DAEMONS_PATHFINDER=openai`) |
| `OPENAI_REASONING_EFFORT`, `_BATTLE`, `_DIALOG` | `high` | `medium` | reasoning effort for a turn, in battle, in dialogue |
| `OPENAI_REASONING_EFFORT_CRITICISM` | `high` | | for self-critique |
| `OPENAI_REASONING_EFFORT_SUMMARY` | `medium` | | for the summary; upstream ran it at `xhigh` |
| `OPENAI_REASONING_SUMMARY` | `auto` | | reasoning summaries in the stream |
| `OPENAI_TOKEN_LIMIT` | `250000` | `200000` | fold the history when the context passes this |
| `OPENAI_TIMEOUT_MS` | 15 minutes | | per call |
| `OPENAI_MAX_RETRIES` | `2` | `0` | the SDK's retries; against a local server a retry runs beside the first call |
| `OPENAI_SERVICE_TIER` and its `_SELF_CRITICISM`, `_SUMMARY`, `_PATHFINDING` | `priority` | | OpenAI's service tier |

## The fork's own knobs

| variable | default | `--ai` sets | what it does |
|---|---|---|---|
| `DAEMONS_TOOLS` | `flat` | `flat` (`--nested-tools`: `nested`) | one tool per action, or upstream's single `execute_action` |
| `DAEMONS_SCHEMA` | `full` | `full` (`--simple-schema`: `lean`) | `full` is eleven actions; `lean` drops `add_marker`, `delete_marker` and `restart_console` |
| `DAEMONS_KEEP_IMAGES` | `2` | | turns of screenshots kept in the history; `0` plays without the screen |
| `DAEMONS_KEEP_REASONING` | `2` | | the model's own reasoning items replayed to it; `0` replays none |
| `DAEMONS_SUMMARY_EVERY` | `120` | | steps between summaries |
| `DAEMONS_CRITIQUE_EVERY` | `40` | | steps between self-critiques |
| `DAEMONS_SELF_CRITIQUE` | `1` | | `0` turns self-critique off |
| `DAEMONS_MAX_OUTPUT_TOKENS` | `32000` | `4096` | a ceiling on one generation |
| `DAEMONS_STORE` | `1` | `0` for OpenRouter models | the Responses API's `store`; OpenRouter refuses `true`, and nothing here reads a stored response back |
| `DAEMONS_PATHFINDER` | `local` | `local` | the in-process pathfinder; `openai` restores upstream's, which needs OpenAI's Code Interpreter |
| `DAEMONS_EXTEND_TOOL_OUTPUT` | off | off | `1` attaches screenshots to tool results as an array, which LiteLLM's bridge rejects |
| `DAEMONS_DUMP_INPUT` | unset | `ai/logs/last-input.json` | write the exact request body of each turn to this file |

## Hearing it

| variable | default | `--ai` sets | what it does |
|---|---|---|---|
| `DAEMONS_VOICE_URL` | unset: the play button reports it is off | DAEMONS' n8n voice workflow, on the private network or else the public relay | where `/speak` sends a line |
| `DAEMONS_VOICE_RELAY` | the public relay | | tried when `DAEMONS_VOICE_URL` cannot be reached |
| `DAEMONS_VOICE` | `index` | | the voice to speak in |
| `DEX_SHARED_SECRET` | empty | forwarded | sent as a header to the voice workflow; it stays in the agent, never in the page |

## Ports and the bridge

| variable | default | `--ai` sets | what it does |
|---|---|---|---|
| `WS_PORT` | `9885` | | the agent's HTTP and WebSocket port, which the dashboard connects to |
| `PYTHON_BASE_URL` | `http://127.0.0.1:8000` | | where the agent finds the bridge |
| `FIRERED_SYM_PATH` | `pokefirered.sym` (retail) | `ai/pokefirered.sym`, from this build | the symbol table the bridge reads RAM by |
| `FIRERED_BRIDGE_STRICT_SYMBOLS` | `0` | `1` | fail on a missing symbol instead of reading zeroes |
| `MGBA_TRANSPORT`, `MGBA_SOCKET_*`, `MGBA_API_URL`, `MGBA_HTTP_TIMEOUT`, `MGBA_READ_RANGE_CHUNK` | socket, 8888 to 8896 | | how the bridge reaches mGBA |
| `FIRERED_GAME_DATA_DIR`, `FIRERED_MINIMAPS_DIR`, `FIRERED_SCREENSHOT_DIR` | `game_data_firered`, `minimaps`, `tmp_screenshots` | | the name tables, the explored map, the screenshots |
| `FIRERED_SAVESTATE_BACKUP_*`, `FIRERED_BENCHMARK` | backups on, every 300 s, keep 50 | | upstream's savestate backups and benchmark logging |

## In DAEMONS' `bindDaemons.sh` only

| variable | default | what it does |
|---|---|---|
| `DAEMONS_LLM_HOST` | probed | the LiteLLM proxy's host, if the probe should be skipped |
| `DAEMONS_DASH_PORT` | `5173` | the dashboard's port |
| `DAEMONS_KEEP_RUNS` | `5` | archived runs `--fresh` keeps; `0` keeps them all |

Most of these, set in the environment before `--ai`, win over what it would set. Four do not: `DAEMONS_TOOLS` and
`DAEMONS_SCHEMA` follow its flags, the two symbol settings always point at this build, and `OPENAI_API_KEY` is always
the proxy's own -- so a real OpenAI key exported in a shell is never sent to a proxy that never needed it.
