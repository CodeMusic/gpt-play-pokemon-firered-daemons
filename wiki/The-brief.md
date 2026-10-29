# The brief

The brief is [`server/prompts/game.txt`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/prompts/game.txt),
about 1,600 lines, sent as the developer message on every turn. It began as Clad3815's FireRed prompt. This fork
rewrote it in DAEMONS' words and **keeps it current with the game**: it has been brought up to date a piece at a time
since late September, and the agent knows the game as of 2026-10-28 (DAEMONS ticket T-319,
[Keeping it current](Keeping-it-current)). Four more prompts sit beside it -- the summary, the summary rollup, the
self-critique and upstream's pathfinder -- and they are held to the same words.

## What it covers

| | |
|---|---|
| **Who it is** | an AI playing DAEMONS through an emulator, named `GPT` in the game; the mechanics are FireRed's and the names are not |
| **Priorities** | become CHAMPION and finish the post-game, efficiently and reliably |
| **Its data** | what comes from RAM, what its memory and objectives are for |
| **The tools** | when to walk a path, press keys, mark a map, write a memory, set objectives, reload a save |
| **The road** | the eight MARKS and the CHAMPION, and the game's own road beside them |
| **Its party** | bind daemons, four to six before the second BENCHMARK, chosen to cover what the party cannot answer |
| **Saving** | when and how, and reloading after a disaster |
| **Moving and exploring** | explore before backtracking, the explored map and its unknown tiles, cities and buildings |
| **Maps** | hidden warps, exit carpets, edges and connections, markers on doors and stairs, mazes |
| **Talking** | what goes in `step_details` and `chat_message`; the aside's own rules are in its tool field ([Its inner life](Its-inner-life)) |
| **Menus** | the START menu's two columns, shops, the party, naming |
| **Battle** | turn order, switching, status, abilities, healing, and the type chart in the game's own type names |
| **Getting unstuck** | what to try, in order |

## What it is told about DAEMONS

**The names are not FireRed's.** A total conversion renames every place, person and object, and a name filled in from
memory gets written into the objectives and acted on. So the brief opens with the earliest of them -- the towns,
CRYSTAL CLEAR (a researcher, with no title), DAEMONS, THE REPO, CHECKPOINT, the INDEX, BOXES and binding, MARKS,
HALTED and the statuses, the items, ROUTINES, PLUGINS and DRIVERS, the BENCHMARKS and THE REVIEW BOARD, CORPUS -- and
then the rule: **read the name off the screen or off the data, and never supply one from memory.**

**The opening, in order**, so it does not invent one and walk to the wrong place for twenty turns.

**Names worth reading for fifty hours.** A nickname and the rival's name are decided before the naming grid opens, and
must read as a name: no `AA`, no `ABABAB`, nothing a person would not call a creature out loud.

**The game's own road.** DAEMONS is not only eight MARKS. The brief says what the school, the Reading Room, the GUIDE
and the UNDERSTANDINGS are, and that an understanding is arrived at, never handed over, ground or bought. Its prompt
lists the understandings it holds and the MARKS by name, and it is told to stop and notice what changed when one is
added.

**The world as it is now**: the STREAM's lessons, the NOTEBOOK, the follower and the moods the game shows and never
names, BOUND on the INDEX, the rare other colours, the TOWN MAP drawn as a score, the seasons, the weather and what it
lifts in battle, the holidays, colour as trust, OPUS in the margins, THE SUBTLE LAYER, the instrument and the SONGBOOK
-- songs are learned by ear, and nobody plays one for you -- and the side threads, which are never required.

**Never SEND.** A daemon sent to a companion device is AWAY and cannot battle until that device sends it back, which the
agent cannot do.

## Who it is looking at

**People are named in the game's own words.** The bridge names each person on the map from the object-name table, which
DAEMONS builds from the engine's own list of object graphics: 237 of them, where vanilla's table held 153. People drawn
as a trainer class take the game's name for that class, and a seasonal daemon its species. An invisible object is not
listed at all, so a hidden thing is found the way a player finds it.

## What it is not told

**A song's notes.** The SONGBOOK is listed by title only.

**That a person is watching.** The backchannel is something that can be consulted and sometimes answers, nothing more
([Playtesting and the backchannel](Playtesting-and-the-backchannel)).

**Its own score.** It sees what has changed in words, never the number ([The agent loop](The-agent-loop)).
