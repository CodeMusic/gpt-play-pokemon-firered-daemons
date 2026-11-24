// BRAIN: none -- the OpenAI client, pointed at whichever mind mind.js resolved
const OpenAI = require("openai");
const { config } = require("../config");

//  DAEMONS: point the client at any OpenAI-compatible endpoint.
//
//  The model MUST take images. The harness reads state out of RAM *and*
//  attaches a screenshot to every decision, so "it reads RAM, nothing needs
//  vision" is wrong -- ai/litellm/config.yaml already records the symptom:
//  ternary-bonsai-8b-mlx returned "The provided input contains images, but
//  ternary-bonsai-8b-mlx does not support image inputs." I wrote that wrong
//  claim here anyway, and then repeated it out loud a session later.
//
//  A text-only model is only usable with DAEMONS_KEEP_IMAGES=0.
//
//  Unset, this falls back to api.openai.com exactly as before, so the change
//  is inert for anyone not using it.
//  DAEMONS: retries are not free against a local model, they are multiplied.
//
//  The SDK defaults to maxRetries 2 and this client never set it. Against
//  api.openai.com a retry costs a little money and a cancelled request stops
//  costing anything. Against mlx-vlm it costs a GPU: the abandoned generation
//  is NOT cancelled, it keeps decoding to completion, and the retry decodes
//  alongside it.
//
//  Observed directly -- in_flight=3, which is one call and two retries, with
//  decode collapsing from ~100 tok/s to 17 as they competed, and one orphan
//  still generating 256 seconds after its client had gone. That is a spiral,
//  not a hiccup: slower turns cause more retries, and more retries make turns
//  slower. 97 requests started against 95 completed.
//
//  So the retry count is settable, and bindDaemons.sh takes it to 0 for --ai.
//  A local failure is better surfaced than silently tripled.
const openai = new OpenAI({
  apiKey: config.openai.apiKey || "local",
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  timeout: config.openai.timeout,
  maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 2),
});

//  DAEMONS (T-560): a local mind (the Tiiny, or LiteLLM in front of it) is spoken to in chat completions; the harness
//  keeps calling responses.create() and src/ai/chatBridge.js answers it. DAEMONS_API is set by src/ai/mind.js.
const { makeResponsesCreate } = require("../ai/chatBridge");
const responsesCreate = openai.responses.create.bind(openai.responses);
const chatCreate = makeResponsesCreate(openai);
openai.responses.create = (...a) => (process.env.DAEMONS_API === "chat" ? chatCreate : responsesCreate)(...a);

//  T-560: the dashboard's MIND card changes the mind while the agent runs. The client is shared by reference across
//  the harness, so it is pointed at the new mind in place; the next call (never one already streaming) goes there.
function retarget() {
  const { config } = require("../config");
  openai.baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  openai.apiKey = process.env.OPENAI_API_KEY || "local";
  config.openai.model = process.env.OPENAI_MODEL || config.openai.model;
  config.openai.modelPathFinding = process.env.OPENAI_MODEL_PATHFINDING || config.openai.modelPathFinding;
  config.openai.apiKey = openai.apiKey;
  config.openai.store = false;   // no mind of mind.js's keeps one; OpenRouter refuses it outright
}

module.exports = { openai, retarget };

