# Its inner life

The agent has a voice, and three layers behind it that make the voice somebody's rather than nobody's. **The model is
never asked how it feels or how it is doing.** Every time this fork let a model assert something about itself, the
value drifted; every time it read the game's own data instead, it was right. So the feelings are measured, and the
model writes only what a voice would: a thought, a sentence about how it plays, a dream.

| layer | what it is | from | written |
|---|---|---|---|
| **aside** | one or two sentences of inner thought | the model | every turn |
| **feelings** | four humours and a drive | the score's snapshot and the party's HP | every turn |
| **self** | what it has noticed about how it plays | the model, when it reflects | at a boundary |
| **dream** | what the summary threw away | the model, from the new summary, the self and the recent asides | after each summary |

All four are kept with the run in `server/gpt_data/`, shown on the dashboard, and cleared by `--fresh`.

## The aside

A field on every tool call, so it costs no turn. The schema asks for a thought, not a note: complete sentences, the
present tense, as if nobody can hear. It is to be spoken **as the person in `<self>`**, coloured by `<feelings>`
without ever naming them, and in battle it says what is felt, not only what is reckoned. "Menu first, then options." is
procedure and belongs in `step_details`. It is told not to open every line with "I", and that if something happens its
own action does not explain, a person may have taken the controls. The last 200 are kept.

## The feelings

[`server/src/core/feelings.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/feelings.js).
Four axes named for the classical humours, because DAEMONS already has a Review Board of four humours and they are the
same four:

| humour | reads | |
|---|---|---|
| Sanguine | **GLAD** | |
| Choleric | **MAD** | |
| Melancholic | **SAD** | |
| Phlegmatic | **CALM**, or **AFRAID** below zero | the only two-sided one: afraid is phlegmatic inverted |

The other three have nothing on their far side -- there is no feeling beyond un-sad -- and the data agreed: they never
received a negative push at all.

What moves them, each turn:

| what happened | |
|---|---|
| a MARK earned | GLAD, and CALM |
| a daemon bound, levels gained | GLAD |
| new ground | a little GLAD, a little less settled |
| a lot of CACHE spent | a little SAD |
| HALTED | SAD, AFRAID and MAD |
| the party badly hurt | AFRAID |
| the party restored from below half | CALM, less SAD |
| the same move blocked again | MAD, more each time |
| an answer through the backchannel | less MAD, less RESTLESS, CALM -- modestly, so asking is never a reset button |
| arriving at a CHECKPOINT | anger drops away, fear turns over into calm and sadness eases: healing reads as relief, not as nothing |

**Everything decays toward nothing, with a half-life of 15 turns.** Standing still in a menu is not being blocked:
only a walk that went nowhere counts. The model is shown only what is live, as words -- "a little AFRAID", "very MAD"
-- and told to let it colour the aside and never to say the words.

**BOREDOM is a drive, not a humour**, and shows as **RESTLESS**. It rises a little every turn nothing happens, and any
real progress clears it at once. It is the counterweight to AFRAID: an agent hiding from tall grass because its daemon
is hurt is sensible for a while and then simply stuck. It speaks as a want, not a number:

> *You have been going over the same ground too long. Somewhere you have not been is worth the risk of getting there.*

When MAD and RESTLESS are both high, the prompt suggests `consult`
([Playtesting and the backchannel](Playtesting-and-the-backchannel)).

The feelings are the harness's and stay out of the game. The game gives its daemons moods of their own, shown and
never named; this is a different instrument, pointed at the player.

## The self

`reflect` asks for one sentence about the agent as a player, in the present tense, **describing the player it is
becoming**: not "I commit to routes too early" but "I check the collision data before committing to a route". The aside
speaks as this person every turn, so describing a fault rehearses it and describing the fix rehearses that. An exact
repeat of an earlier observation is counted rather than added -- "noticed 3 times" -- and the six newest are kept.

## Reflection, asked at the boundary

A tool named once in the prompt went unused for 357 steps, because nothing ever made it the obvious next move. So the
harness notices the moment instead:

| when | asked |
|---|---|
| the primary objective is replaced | `<reflect_now>`: what was learned, before it is folded away |
| a trainer battle ends, or a battle is lost | `<reflect_now>` |
| HALTED, three blocked moves, a MARK, a new map | `<worth_remembering>`: save a `tips_` memory if there is a rule in it -- at most once in 12 steps |

An empty reflection is refused, in the schema and again in the handler, because a recovered tool call skips the
schema.

## Dreams

[`server/src/core/dream.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/dream.js).
A summary keeps what happened and throws the texture away on purpose. A dream runs on the same boundary and keeps the
other half: one short call with no tools, written from the stretch just summarised, coloured by the self and the
last dozen asides. Three or four sentences, images rather than events, one detail out of proportion. **It is not a record**; a
dream that reads like a report has failed. The newest eight are kept, and the last one rides in the next prompts as a
mood it is told never to quote.

> *The PC yawns open and is empty as a throat. A paper questionnaire hovers over a counter like a moth, YES and NO
> pulsing under my thumb.*

## Hearing it

Any aside, self observation or dream can be **spoken aloud in the INDEX voice**: press its play button on the
dashboard. The page asks the agent, and the agent's `/speak` sends the line to DAEMONS' n8n voice workflow, so any
shared secret stays in the agent and never reaches the page. It tries the private network first and a public relay
when that cannot be reached. A line already heard replays from the page's cache. With `DAEMONS_VOICE_URL` unset, the
button says the voice is off.
