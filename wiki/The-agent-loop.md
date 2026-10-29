# The agent loop

The loop is Clad3815's: read the game, build a prompt, ask the model, run what it chose, repeat. It lives in
[`server/src/core/gameLoop.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/gameLoop.js),
with the prompt in
[`promptBuilder.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/ai/promptBuilder.js)
and the tools in
[`tools.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/ai/tools.js).

## One turn

| | |
|---|---|
| 1 | **Paused?** Wait. A person has the controls ([Playtesting and the backchannel](Playtesting-and-the-backchannel)) |
| 2 | **Read the game** from the bridge: the whole state and a screenshot |
| 3 | **Measure it**: the score, the feelings, and the events worth noticing -- a MARK, new ground, HALTED, a battle ending, the same move blocked three times |
| 4 | **Keep the record**: milestones ticked, maps visited, MARKS earned, a first visit noted |
| 5 | **Fold, if it is time**: a summary every 120 steps or when the context passes the token limit, then a dream |
| 6 | **Build the prompt**: the brief, then this turn's state, then anything the moment calls for |
| 7 | **Critique, if it is time**: every 40 steps, with a count of what the last 40 steps actually did |
| 8 | **Ask the model**, streamed, through the Responses API |
| 9 | **Run what it chose**: buttons go to the bridge, a path is solved into buttons, notes go into the run's state |
| 10 | **Guard against the loop**: a repeated move that went nowhere is taken back out of the history |

## What the prompt carries

The brief is the developer message, the same every turn ([The brief](The-brief)). Each turn's state follows it as
tagged blocks: where the player is and whether a dialogue is open; the player, the MARKS held by name, the
understandings, the SONGBOOK and the weather; the party, the bag, the PORT; the battle; the objectives and what has
changed since it last reflected, in words; memory; the self-model, the last dream and the feelings
([Its inner life](Its-inner-life)); the markers; the tiles on screen and the explored map.

Then, only when the moment calls for it: a note that the game is already underway and the objectives may be stale; a
note that a person had the controls; a line from the backchannel; a suggestion to `consult` when it is stuck; a
suggestion to save a `tips_` memory after something worth learning from; a playtest question; a request to `reflect`;
a reminder that the last self-critique is a hypothesis. Before a save is loaded, the prompt says only that the game has
not started and that it should press a button.

## The tools

Each action is its own tool (`DAEMONS_TOOLS=flat`). Upstream wraps them all in one `execute_action`; that is
`nested`, kept for a serving layer that handles it ([Local and open models](Local-and-open-models)).

| tool | what it does | |
|---|---|---|
| `key_press` | one or several buttons in order; `a_until_end_of_dialog` presses A through a dialogue, and `face_up` and the rest turn without moving | |
| `path_to_location` | walk to a tile on this map in one turn, solved in-process | |
| `update_objectives` | the primary, secondary and third objectives and any others, each with a reason | |
| `write_memory`, `delete_memory` | notes kept by key, with prefixes such as `location_`, `quest_`, `item_` and `tips_` | |
| `reflect` | what it learned, what worked, what wasted turns, and one sentence about itself | ours |
| `consult` | one question, which may be answered or not | ours |
| `playtest` | a note about the game as a place | ours |
| `add_marker`, `delete_marker` | a labelled mark on a map tile, drawn on the dashboard's minimap | full schema |
| `restart_console` | back to the title screen, to reload the last save | full schema |

`DAEMONS_SCHEMA=lean` drops the last three, leaving eight. Every call also carries `step_details` (what happened and
what this does), `chat_message`, an `aside` and three optional `playtest_` fields, so a thought and a playtest note
never cost a turn of their own.

## Objectives, memory and markers

Upstream's, and the agent's own: it sets its objectives, writes its memory and places its markers, and all three are
put back in front of it every turn. This fork stamps each objective with the map it was written on, so an objective
written in a room it has since left says so. `reflect` saves what it learned as a numbered `learned_` memory.

## The score

[`server/src/core/progress.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/progress.js)
turns each turn's state into one number, so a run can be judged without watching it and two runs compared without
anyone remembering how the last one felt:

| | points |
|---|---|
| a MARK | 1,000 |
| a map seen | 40 |
| a level, summed across the party | 6 |
| a daemon caught | 25 |
| a daemon seen | 4 |
| 1,000 CACHE | 2 |

The model never sees the number. It sees the change in words since it last reflected ("Since then: 2 new maps, 3
levels gained."), because a sentence can be acted on and a score cannot. *The caught and seen terms read INDEX counts
the bridge does not send yet, so for now caught counts the party and seen counts nothing.*

The milestones are a separate list,
[`server/progress_steps.json`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/progress_steps.json):
26 steps along the story, each ticked by a MARK, a map reached or a story flag. The dashboard's Progress tab shows them.

## Summaries and folds

The history grows every turn until it is folded. **Every 120 steps, or when the context passes the token limit**, the
model summarises the stretch (`prompts/summary.txt`), and the summary replaces it. When ten summaries have piled up
they are rolled into one (`prompts/summary_rollup.txt`). A dream is written after each summary.

Three things keep the fold from taking the run down with it:

- the summary is read from what was streamed, because one field of the final response comes back empty through
  LiteLLM's bridge
- the text is judged on substance, not on whether its tags were closed just so
- **three failures cost a summary, not the run**: the history is then trimmed mechanically, at a boundary that never
  separates a tool call from its result, and the old history is saved to `server/backup/`

Between folds the history is thinned as upstream's was -- older tool results, maps and images dropped -- and this fork
adds the model's own reasoning to that list: only the last two reasoning items are replayed to it.

## Self-critique

Every 40 steps the model reviews its own play (`prompts/self_criticism.txt`), and the critique appears on the
dashboard. **It is given the trajectory**
([`trajectory.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/trajectory.js)):
distinct positions against moves, the most revisited tile, the tools used -- counts, never a verdict. Without it the
critique was asked to find loops while shown one screen, and reported none during an hour of walking into one wall. The
next turn is told the critique is a hypothesis: where it matches the screen, act on it; where the screen disagrees,
the screen wins.

## The loop guard

A model that has said the same wrong thing six hundred times in its own history is outvoted by itself, however clearly
each correction is put. So:

| | |
|---|---|
| **A blocked move, sent again** | from the same tile, the same keys, is refused before it runs, with a reason; every fifth is let through, since an NPC may have stepped aside |
| **A repeated turn that went nowhere** | is taken out of the history, call and result together, and replaced by one line saying it failed and to do something different |
| **Every move** | says whether the player actually moved |
| **A call that never parsed** | a path whose coordinates did not parse is refused rather than walked, and a stored call whose arguments are not valid JSON is dropped from the history with its result, so a provider never refuses a whole request over it |

The guard compares the **action**, never the commentary: two identical presses into the same wall with differently
worded captions are the same turn.
