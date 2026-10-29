# The dashboard

**DAEMONS Agent Monitor** is a static page in
[`frontend/`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/tree/context-content/frontend) that watches
the agent over a WebSocket. It is a window, not a remote: it sends the agent nothing but a pause, a line for the
backchannel, and a request to hear a thought. `./bindDaemons.sh --ai` serves it at `http://localhost:5173`; by hand,
`cd frontend && python -m http.server 5173`. Clad3815 built it; this fork took DAEMONS' palette, a light and dark
theme, and the panels marked *ours* below.

![The dashboard during a run: Runtime, Inner life, User and Frames across the top, the tabs below with Memory & Self
open, showing a learned memory and three dreams.](https://raw.githubusercontent.com/CodeMusic/gpt-play-pokemon-firered-daemons/context-content/docs/screenshots/dashboard.png)

*The picture is from a run in September 2026, before the Playtest tab, the Backchannel and the pause button were
added.*

## The top bar

| | |
|---|---|
| **Host, Port** | where the agent is: `localhost` and `9885` by default |
| **Poll (ms)** | how often the minimap is fetched |
| **Auto reconnect** | reconnect when the agent restarts |
| **Connect, Disconnect** | |
| **Pause agent** | *ours*: stop the agent stepping while a person plays; **Resume agent** hands back ([Playtesting and the backchannel](Playtesting-and-the-backchannel)) |
| **Clear logs** | |
| **Theme** | *ours*: auto follows the system; or light, or dark |

## Always on screen

| panel | what it shows |
|---|---|
| **Runtime** | connected, and whether the agent is thinking; the **progress score**, *ours*, with what has changed since it last reflected and its working in a tooltip; the step, steps until the next summary and the next critique, tokens, cost, reasoning, tool and total time, down time, the Safari Zone's state |
| **Inner life** | *ours*: the feelings -- GLAD, MAD and SAD as bars, the AFRAID-to-CALM axis from its centre, RESTLESS below its own rule -- and the asides, newest first, each with a play button |
| **User** | name, CACHE, map and its id, position, MARKS held, and flags: VERBOSE needed or active, reduced visibility, in dialogue, in battle |
| **Frames** | *ours*: the last four screens the agent saw, newest first; click one to see it full size |
| **Agent Log** | what the agent did: each action and its result, status lines, errors, and its reasoning as it streams |
| **Minimap** | the explored map with the player on it, the legend of the tiles in view, and the agent's markers on this map |
| **Backchannel** | *ours*: what has been said to the agent and what it has asked, each line marked queued or read, and a box to say something. An unanswered question can be clicked to answer it |

## The tabs

| tab | what it shows |
|---|---|
| **Summary** | the last summary and the last self-critique, side by side, as they stream; until the first, how many steps away it is |
| **Party** | each daemon: nickname, species, level, HP, ROUTINES with PP, types, status, shiny, and which is in battle |
| **Inventory** | the bag, pocket by pocket |
| **Objectives** | primary, secondary, third and the rest, each with its reason |
| **Progress** | the 26 milestones along the story, ticked as they are reached, with a bar |
| **Memory & Self** | *ours, in part*: the agent's memory; its **Self**, each observation with how often it has been noticed; its **Dreams**, the newest four. Each self line and dream has a play button |
| **Playtest** | *ours*: the playtest notes, newest first, coloured by kind, with where and when, and a tally of each kind |

## Hearing a line

A play button speaks the line in the INDEX voice ([Its inner life](Its-inner-life)). One line speaks at a time, a line
already heard is marked as cached and replays at once, and the button says so when the voice is not configured.
