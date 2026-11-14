# Which mind plays, and which model on it

*DAEMONS T-560, 2026-11-14. The setting is `DAEMONS_MIND` ([wiki: Configuration](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/wiki/Configuration));
this page is the evidence behind its defaults.*

## The four minds

| `DAEMONS_MIND` | what plays | how it is reached |
|---|---|---|
| `mind` **(default)** | whatever mind the companion's hub uses, if it is well | the hub is *asked* (`GET /api/talk/settings` on daemons-hearth, over ssh), not called; the harness then talks to that mind itself. Fallbacks: the Tiiny directly, then seer. Never OpenRouter |
| `tiiny` | the Tiiny, directly | `http://openai.api.tiiny/v1`, its own key |
| `seer` | LiteLLM on roverbyteseer:4000 | `tiiny-35b`, `tiiny-9b`, and every other name it carries |
| `openrouter` | hosted open models, **paid** | LiteLLM's `or-*` names; `or-muse-glimmer` by default |

**Why the hub is asked rather than called.** The hub speaks *for a daemon*: `/api/ai/talk` wraps every call in the
daemon's self, takes no tools, keeps six turns and does not stream text. A playing agent needs tools, a long history
and a stream. On 2026-11-14 the hub reported its mind as the Tiiny through LiteLLM (`http://roverbyteseer:4000/v1`,
`tiiny-35b`), healthy, so `mind` resolves to seer's `tiiny-35b` today.

## What the Tiiny serves, and how it must be spoken to

`/v1/models` on the Tiiny, 2026-11-14: two chat models, **Qwen3.6-35B-A3B** and **Qwen3.5-9B**, both marked
`Image-Text-to-Text`, `supported: Reasoning, Tool Use`, vision on, thinking on by default and switchable; beside them
the hearing (Qwen3-ASR-1.7B), the voice (Qwen3-TTS-12Hz-1.7B-VoiceDesign) and an embedder. It is llama.cpp serving
q8_0 GGUFs. **"muse glimmer" is not on it**: `or-muse-glimmer` is OpenRouter's `meta/muse-glimmer-30b`, pinned to
DeepInfra, in DAEMONS' `ai/litellm/config.yaml`.

The Tiiny's **Responses API** exists but is narrow. Measured:

| sent to `/v1/responses` | answer |
|---|---|
| `reasoning: {effort}` | 400 `unsupported_parameter` |
| `service_tier` | 400 |
| `chat_template_kwargs` (the thinking switch) | 400 |
| an `input_image` | 400, *content block type 'input_image' is not supported* |
| plain text + one tool | a correct call, after thinking it cannot turn off: 15 s, 38 s, 73 s for a one-line task |

Its **chat completions** take all of it: a screenshot, a tool and `enable_thinking: false` came back as a correct
call in 8 s. So the local minds are spoken to in chat completions, through `server/src/ai/chatBridge.js`, which answers
the harness's `responses.create()` calls so that no call site changed. LiteLLM passes `chat_template_kwargs` through
to the Tiiny unchanged (checked), so seer behaves the same.

## The measurement

`server/tools/mindbench.js` replays a real recorded run (DAEMONS `ai/logs/last-input.json`, steps 51-63 of a
September run, Blanche Town to the lab) through the real client: for each of its 13 game states, the mind gets
today's developer prompt (`game.txt` and the rest, about 40,700 tokens), today's 11 flat tools, and the recorded
history up to that state, and is asked for the next action exactly as `gameLoop.js` asks (`tool_choice: required`,
one call, streamed, 4,096 tokens at most). A turn is **valid** when it makes exactly one call, to a tool that exists,
with arguments that parse and meet the tool's required fields and enums. **Same** is whether it chose the tool the
recorded run chose: a sanity line, not a goal.

| model, thinking | valid | same | median s | max s | mean tokens out |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B, off (first run) | 12 / 13 | 9 | 15.3 | 25.2 | 214 |
| Qwen3.5-9B, off (first run) | 12 / 13 | 9 | 18.5 | 49.7 | 203 |
| **Qwen3.6-35B-A3B, off, images flattened** | **13 / 13** | 7 | 21.4 | 88.7 | 446 |
| Qwen3.6-35B-A3B, on, images flattened | 12 / 13 | 7 | 42.7 | 231.2 | 874 |

**The first runs each failed one turn the same way, and it was not the model.** The last turn's user message carries
two screenshots, and the second is the harness's grid overlay (`screenshotService.js` composites it with sharp), the
only **RGBA** PNG the harness makes. Both models answered *Upstream model server request failed* in under 3 s, and
**each time the Tiiny then unloaded the model** -- three times in all, which also took the companion's own talk down
until the model was loaded again. A single RGB 720x480 screenshot two turns earlier had been fine. `chatBridge.js` now
flattens every image to RGB and sends one per message (`DAEMONS_MAX_IMAGES_PER_MESSAGE`, default 1), keeping the
first -- the clean screenshot -- because the 35B, shown the overlay alone, described Blanche Town as "a colorful,
grid-based multiplication table". The flattened overlay then went through in 4.1 s with the model still loaded, and
the rerun above passed the turn that had failed.

Every valid call was well-formed JSON on the first try: no salvage, no duplicate calls, no text-only answers. Thinking
on cost twice the median time, ten times the worst case, and one invalid argument (`playtest_kind` outside its enum),
for no better agreement with the recorded run. The first turn of a run is slower than the rest (the prompt is read
once, then cached), and the Tiiny's times vary between runs by about a third.

## The choice

**Qwen3.6-35B-A3B with thinking off** (the user, 2026-11-14, by multiple choice). It ties the 9B on validity, is
faster at the median and the worst case in the like-for-like run -- it is a mixture of experts with about 3B active, so its size costs memory
rather than time -- and it is the stronger voice for the inner life. Thinking is off by default on every chat mind (measured
above: on is slower and no better); `DAEMONS_THINK=1` turns it back on.
