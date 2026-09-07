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

module.exports = { openai };

