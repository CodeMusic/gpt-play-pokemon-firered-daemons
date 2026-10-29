# gpt-play-pokemon-firered-daemons

**The harness that lets a model play [DAEMONS](https://github.com/CodeMusic/DAEMONS)**, a total conversion of
*FireRed* where the creatures are daemons and the type chart is an argument about consciousness. mGBA runs the game, a
Lua script inside it opens a socket, a Python bridge reads the game out of RAM by symbol name, and a Node agent asks a
model what to do and presses the buttons. A dashboard in the browser shows what it sees, what it does and what it
thinks while doing it.

**It is a fork of [Clad3815/gpt-play-pokemon-firered](https://github.com/Clad3815/gpt-play-pokemon-firered), and the
hard parts are theirs**: the mGBA Lua bridge, the RAM reader, the agent loop, the prompts it started from and the
dashboard. They work, and everything here is built on them. This fork points them at DAEMONS and makes them run on a
model that is not a frontier one.

New to the game itself? **[The player's manual](https://github.com/CodeMusic/DAEMONS/blob/main/docs/DAEMONS-manual.pdf)**
(PDF) tells how to play it.

## What this fork adds

| | |
|---|---|
| **The game's own words** | name tables, type names, prompts and milestones in DAEMONS' vocabulary, and a brief kept current with the game ([The brief](The-brief)) |
| **Any OpenAI-style endpoint** | `OPENAI_BASE_URL`, LiteLLM in front, and what a local or open model needed: a local pathfinder, recovered tool calls, a cap on each turn ([Local and open models](Local-and-open-models)) |
| **An inner life** | a thought each turn, four humours and a drive derived from play, a self-model, a dream after each summary, any of it spoken aloud ([Its inner life](Its-inner-life)) |
| **A playtester** | notes on the game as a place -- LIKED, DISLIKED or CONFUSED -- for the people building it ([Playtesting and the backchannel](Playtesting-and-the-backchannel)) |
| **A backchannel and a pause** | something to say to the agent, one question it may ask back, and a button to take the controls |
| **A score and a loop guard** | one number for how a run is going, and a guard that stops it reading its own failed moves back as a plan ([The agent loop](The-agent-loop)) |

## Every page

| page | what it covers |
|---|---|
| [Running it](Running-it) | what it needs, `./bindDaemons.sh --ai` from DAEMONS, the Lua step in mGBA, by hand, resuming and `--fresh` |
| [Configuration](Configuration) | every environment variable, its default here and what `--ai` sets it to |
| [How it reads the game](How-it-reads-the-game) | the four layers, symbols from our build, what is read out of RAM, the name tables, the explored map, the screen |
| [The agent loop](The-agent-loop) | one turn, the tools, objectives, memory and markers, the score, summaries and folds, self-critique, the loop guard |
| [Local and open models](Local-and-open-models) | the Responses API and LiteLLM, the local pathfinder, recovered tool calls, what keeps a turn short |
| [Its inner life](Its-inner-life) | the aside, the feelings, the self-model, reflection, dreams, and hearing them |
| [Playtesting and the backchannel](Playtesting-and-the-backchannel) | playtest notes, `consult` and the backchannel, pausing to take the controls |
| [The dashboard](The-dashboard) | every panel and tab |
| [The brief](The-brief) | what the agent is told about DAEMONS, and what it is never told |
| [Keeping it current](Keeping-it-current) | the DAEMONS tools that regenerate its data, and the check that no vanilla word reaches the model |

## Where it stands

As of 2026-10-28:

- **Built, and played.** It ran through September 2026 against local models (served by LM Studio and mlx-vlm) and
  hosted open ones through OpenRouter. The longest run went past step 1,100.
- **Kept current since, not re-run.** Each change to the game since then has reached the brief, the bridge and the
  name tables (DAEMONS ticket T-319), checked against the engine's source and by DAEMONS' vocabulary check. The most
  recent run on record is from mid-September.
- **Planned.** A longer playtest run, whose notes are then read and triaged, is decided and not yet made.

## Licence

Clad3815's licence carries over:
[CC BY-NC 4.0](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/LICENSE). Forks and
changes are allowed, commercial use is not, and credit is required.

## The DAEMONS family

| | |
|---|---|
| [CodeMusic/DAEMONS](https://github.com/CodeMusic/DAEMONS) ([wiki](https://github.com/CodeMusic/DAEMONS/wiki)) | **the game** -- its design, its tools, its releases and patches, and `./bindDaemons.sh --ai` |
| [CodeMusic/pokefirered-daemons](https://github.com/CodeMusic/pokefirered-daemons) ([wiki](https://github.com/CodeMusic/pokefirered-daemons/wiki)) | the game's engine, the build this harness plays |
| [CodeMusic/daemons-companion](https://github.com/CodeMusic/daemons-companion) ([wiki](https://github.com/CodeMusic/daemons-companion/wiki)) | where a daemon goes when it leaves the game: the app, the hub, the boards |
| [CodeMusic/daemons-playground](https://github.com/CodeMusic/daemons-playground) ([wiki](https://github.com/CodeMusic/daemons-playground/wiki)) | the game in a browser, for demos and beta tests on your own network |
| **CodeMusic/gpt-play-pokemon-firered-daemons** | this: the harness that lets a model play it |

*Pokémon is Nintendo / Creatures / GAME FREAK. This fork is unaffiliated with and unendorsed by them. The harness is
Clad3815's and its contributors'; the writing, music, design and art of DAEMONS are CodeMusic's.*
