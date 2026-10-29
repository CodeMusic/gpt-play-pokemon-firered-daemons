# Playtesting and the backchannel

## Playtest notes

The agent walks a game that is still being built, and it has the one quality a human tester loses within minutes:
**it does not know what anything is supposed to mean.** A sign that reads as atmosphere to whoever wrote it reads as an
instruction to someone arriving cold, and that gap is where the design is failing. So it is asked what it makes of
the game as a place -- not how it is doing at it
([`playtest.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/playtest.js)).

| kind | colour | what it is |
|---|---|---|
| **LIKED** | green | it worked on the agent, and it can say what did it |
| **DISLIKED** | red | a complaint about the design; difficulty is not a fault |
| **CONFUSED** | amber | it had to guess. The most valuable of the three: a tester who works it out can no longer report it |

**The test is whether it would still be true tomorrow, for somebody else.** "The east exit is higher up than it looks
from here" belongs here. "Menu is open" does not; that is this turn, and an aside. A fourth kind, NOTED, was removed:
an observation with no verdict gave the model no test to fail, and sixteen of its first eighteen were play narration.

**How a note is made.** Every tool call carries three optional fields, `playtest_kind`, `playtest_about` and
`playtest_note`, so a note costs no turn; `playtest` is also a tool of its own. A note under twelve characters is
dropped, and one within 15 steps of the last is not recorded. The newest 200 are kept in
`server/gpt_data/playtest.json` and shown in the dashboard's Playtest tab with a tally.

**When it is asked.** On the first arrival at a map, the one turn it is a cold reader of a place; or after 60 steps with
nothing recorded; never twice inside 40 steps. The question rotates -- *What did you have to guess at? What did you
expect to be able to do, and could not?* and three more -- and `<reflect_now>` asks again when an objective is over.

**Kept apart from memory, on purpose.** Memory is what the agent reads back to play better. A playtest note is for the
people making the game, it is never returned to the agent, and it never becomes another thing for it to reason about.
The plan in DAEMONS is to read the file after a run and triage it, CONFUSED first; that run is still to come.

## The backchannel

Named for the listener's "mm-hm": how you steer a speaker without taking the floor
([`backchannel.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/backchannel.js)).

**Anything typed into the dashboard's Backchannel reaches the agent once**, in its next prompt, as something it heard
and cannot check. It is told to let it show in its next aside, to act on it where it matches the screen (the screen
wins where it does not), to keep it as a `tips_` memory if it will still matter after the next fold, and never to say
aloud that it was told anything. It is never repeated, so it cannot become wallpaper the model skims past.

**The agent is never told a person is watching.** It knows only that something can be consulted and sometimes answers.
A run where it starts performing for an audience stops being a model playing the game.

**`consult` is the way back.** The agent may ask **one question at a time**, and silence is a legal answer: an oracle
that always replies is a walkthrough. The question shows on the dashboard as unanswered; click it to answer. The
prompt suggests `consult` only when the agent is both frustrated and restless (MAD and RESTLESS high together, at most
once in 40 steps), the one state where another twenty turns of trying will not help. Being answered settles it a
little ([Its inner life](Its-inner-life)).

Each line on the dashboard says whether it is still queued or has been read. The log keeps 60 entries in
`server/gpt_data/backchannel.json`.

## Taking the controls

**Pause agent**, on the dashboard's top bar, stops the agent stepping so a person can play. A model call already sent
is allowed to land; the next turn simply does not start. **Resume agent** hands the controls back, and the agent's next
prompt says that a person had them: the screen may not be where it left it, none of what changed was its doing, and
nothing that happened is to become a lesson, a reflection or a playtest note.

Before the pause existed the agent kept stepping while a person drove, and wrote what they did into its notes as its
own -- including a CONFUSED report about a save screen that was a person saving.
