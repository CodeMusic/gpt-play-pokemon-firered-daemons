# Local and open models

Upstream assumes a frontier model on OpenAI's API. This fork started as one line: the client was
`new OpenAI({ apiKey })` with no base URL, so it could only reach OpenAI. It takes `OPENAI_BASE_URL` now, and falls
back to `api.openai.com` exactly as before when it is unset
([`openaiClient.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/core/openaiClient.js)).
It did not stay one line.

## It is not one environment variable

Every call uses OpenAI's **Responses API**: `openai.responses.create()` with `input:` rather than `messages:`, plus
`reasoning: {effort, summary}`, `service_tier`, `store`, and `stream: true` read as typed events. LM Studio, llama.cpp
and Ollama serve `/v1/chat/completions`, not `/v1/responses`, so a base URL alone 404s on the first call.

**What works is a [LiteLLM](https://github.com/BerriAI/litellm) proxy in front**, with two settings that are easy to
miss:

```yaml
litellm_params:
  use_chat_completions_api: true   # per model. Without it LiteLLM forwards /v1/responses
                                   # straight through, into the 404 it exists to avoid.
litellm_settings:
  drop_params: true                # service_tier, store, reasoning.summary
```

Checked with streaming: the whole `response.created` -> `in_progress` -> `output_item.added` -> `content_part.added`
-> `output_text` -> `completed` sequence arrives intact through it. DAEMONS keeps a proxy configuration of its own,
and `./bindDaemons.sh --ai --model NAME` picks a model by the name it has there ([Running it](Running-it)).

## What it took

| | |
|---|---|
| **A pathfinder that stays on the machine** | upstream's `path_to_location` has a model write Python and runs it in OpenAI's Code Interpreter, at URLs no base-URL setting redirects; with no OpenAI key it failed five times a call. [`localPath.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/ai/localPath.js) is a breadth-first search over the collision grid the bridge already sends. It treats ledges, ice, spinners, arrow floors, holes and water as blocked rather than guess, so a route may be longer but is never wrong, and when there is no route it says which failure it is and where the player can go |
| **Tool calls the server threw away** | MiniCPM writes tool calls in an XML dialect that mlx-vlm parses strictly, dropping the whole call when the JSON inside is imperfect: 25 of 55 requests in one run. [`salvageToolCall.js`](https://github.com/CodeMusic/gpt-play-pokemon-firered-daemons/blob/context-content/server/src/ai/salvageToolCall.js) recovers them from the raw text and validates them against the schema: 25 of 25 real failures |
| **One tool per action** | through upstream's single `execute_action`, qwen3-vl-8b emitted 27 duplicate calls in one response; as separate tools, one. So flat is the default |
| **A ceiling on a turn** | upstream sends 32,000 output tokens at every call site. At about 70 tokens a second that is seven and a half minutes for one runaway turn; `--ai` sets 4,096, which clears every real turn seen and caps a runaway near a minute |
| **No retries** | against mlx-vlm a retry runs beside the call it replaces, because the abandoned generation is never cancelled. `--ai` sets `OPENAI_MAX_RETRIES=0` |
| **`store` off for OpenRouter** | OpenRouter refuses `store: true`, and `drop_params` cannot help, because `store` is a real Responses parameter. Nothing here reads a stored response back |
| **Images in a user message** | LiteLLM's bridge rejects a tool result whose output is an array, which is how upstream attaches a screenshot. The same images go in a user message instead, and every tool result is a string |
| **Two turns of screenshots, not ten** | ten turns was 13 images and 486 KB of base64 in one request, and one decision took 279 seconds on a local model |
| **Less of its own reasoning** | 105 replayed reasoning items were 28% of an 882,000-character prompt; the last two are kept |
| **A summary that writes** | the summariser ran at `xhigh`, the highest effort in the file, and one attempt spent 570 reasoning events and wrote nothing. It runs at `medium` now |
| **A token limit with room** | upstream folds at 250,000 tokens, a hair under qwen3-vl-8b's context and double gemma-3-4b's; `--ai` folds at 200,000 |

**`DAEMONS_DUMP_INPUT`** writes the exact request body of each turn to a file, which is the first thing to read when a
proxy refuses one.

## Which models

What has been played on it, through LiteLLM: qwen3-vl-8b served by LM Studio, which tool-calls well when the tools are
flat; MiniCPM served by mlx-vlm, which needs the salvage above (it cannot tool-call through LM Studio at all -- its XML
dialect needs SGLang's or vLLM's parser); and hosted open models through OpenRouter, which `--ai` uses by default. A
frontier model on OpenAI's own API still works as it did upstream: leave `OPENAI_BASE_URL` unset.

## The lesson most of these shared

Almost every bug here looked like the model being stupid, and was not. It said "Professor Oak" because the name table
said so. It could not leave the first town because nothing ever told it a map has an edge connection. It named its
starter `AA` because the rule said two to eight characters and two was the floor. **When the model does something
stupid, grep the prompt before blaming the model.**
