//  DAEMONS (T-560): WHICH MIND PLAYS. One setting, DAEMONS_MIND, four answers:
//
//    mind        the default. Ask the companion's hub (daemons-hearth) which mind it is using and whether that mind is
//                well, and play on it. The hub's own answer today is the Tiiny, reached through LiteLLM on
//                roverbyteseer. If the hub cannot be asked, or its mind is not well, try the Tiiny directly, then seer.
//    tiiny       the Tiiny on the desk, directly: http://openai.api.tiiny/v1, its own key.
//    seer        the local cloud: LiteLLM on roverbyteseer:4000, which names the Tiiny's models tiiny-35b and tiiny-9b.
//    openrouter  hosted, and PAID: LiteLLM's or-* names, which go on to OpenRouter. Never the default, never automatic.
//
//  WHY THE HUB IS ASKED AND NOT CALLED. The hub (companion server/src/api.ts) speaks for a daemon: /api/ai/talk wraps
//  every call in the daemon's self, takes no tools, and does not stream text. A playing agent needs tools, a long
//  history and a stream. So the hub is asked WHICH mind -- GET /api/talk/settings, the same view THE HUB card shows,
//  which carries the Tiiny's URL and health and never a key -- and the harness then talks to that mind itself.
//
//  WHY CHAT COMPLETIONS FOR THE LOCAL THREE. The harness speaks the Responses API. The Tiiny serves /v1/responses, but
//  measured 2026-11-14 it refuses `reasoning`, `service_tier` and `chat_template_kwargs` (400 unsupported_parameter)
//  and refuses input_image outright -- and its thinking cannot be switched off there, so a one-line answer took 15 to
//  73 s. Its /v1/chat/completions takes images, tools and enable_thinking, and answered a screenshot plus a tool call
//  in 8 s. So for tiiny, seer and mind the harness's calls go through chatBridge.js, which speaks Responses to the
//  harness and chat completions to the mind. OpenRouter keeps the Responses API through LiteLLM, as it always ran.
//
//  KEYS ARE FETCHED, NEVER STORED. Each comes from the environment if set (TIINY_API_KEY, LITELLM_KEY), otherwise from
//  the machine that holds it, over ssh, at start: the Tiiny's from roverbyteseer's companion seer/.seer, LiteLLM's from
//  roverbyteseer's ~/.litellm.env. Nothing here prints one.
//
//  WHICH MODEL. A mind is a machine; the model on it is DAEMONS_TIINY_MODEL: 35b (Qwen3.6-35B-A3B, the default, the
//  user's pick from the measurements in docs/MINDS.md) or 9b (Qwen3.5-9B). DAEMONS_MODEL, when set, names the model outright.
//  NOT OPENAI_MODEL: bindDaemons.sh has always exported that (or-muse-glimmer), and honouring it would ask the Tiiny
//  for a model it does not have.

const { execFileSync } = require("child_process");

const SEER_HOST = process.env.DAEMONS_SEER_HOST || "roverbyteseer";
const SEER_URL = process.env.DAEMONS_SEER_URL || `http://${SEER_HOST}:4000/v1`;
const TIINY_URL = process.env.DAEMONS_TIINY_URL || "http://openai.api.tiiny/v1";
const HUB_SSH = process.env.DAEMONS_HUB_SSH || "debian@daemons-hearth";
const HUB_API = process.env.DAEMONS_HUB_API || "http://127.0.0.1:4730";

//  The Tiiny's chat models by short name, as the Tiiny names them and as seer's LiteLLM does.
const TIINY_MODELS = {
  "35b": { tiiny: "Qwen/Qwen3.6-35B-A3B", seer: "tiiny-35b" },
  "9b": { tiiny: "Qwen/Qwen3.5-9B", seer: "tiiny-9b" },
};
const OPENROUTER_DEFAULT = "or-muse-glimmer";   // meta/muse-glimmer-30b through LiteLLM, DeepInfra only

const MINDS = ["mind", "tiiny", "seer", "openrouter"];

function sh(args, timeoutMs = 9000) {
  try {
    return execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function sshRead(host, remoteCmd) {
  return sh(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=accept-new", host, remoteCmd]);
}

const unquote = (s) => String(s || "").trim().replace(/^['"]|['"]$/g, "");

function tiinyKey() {
  if (process.env.TIINY_API_KEY) return process.env.TIINY_API_KEY;
  return unquote(sshRead(`roverbyte@${SEER_HOST}`,
    `sed -n "s/^TIINY_API_KEY=//p" ~/Projects/daemons-companion/seer/.seer ~/daemons-companion/seer/.seer 2>/dev/null | head -1`));
}

function seerKey() {
  if (process.env.LITELLM_KEY) return process.env.LITELLM_KEY;
  //  bindDaemons.sh has always fetched this one and exported it as OPENAI_API_KEY; honour that, but only when it is
  //  LiteLLM's own (sk-daemons-...), never a real OpenAI key left in a shell profile.
  if ((process.env.OPENAI_API_KEY || "").startsWith("sk-daemons-")) return process.env.OPENAI_API_KEY;
  return unquote(sshRead(`roverbyte@${SEER_HOST}`, `sed -n "s/^LITELLM_MASTER_KEY=//p" ~/.litellm.env`));
}

//  Is a /v1 endpoint up? Any HTTP answer from /models counts (401 included): it is listening.
function answers(url) {
  const code = sh(["curl", "-s", "-o", "/dev/null", "-m", "5", "-w", "%{http_code}", `${url}/models`], 7000);
  return /^[1-5]\d\d$/.test(code) && code !== "000";
}

//  What the hub says, or null. Read from the hub's own loopback over ssh: that needs no token.
function askHub() {
  const raw = sshRead(HUB_SSH, `curl -s -m 6 ${HUB_API}/api/talk/settings`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return { first: v.first, provider: v.provider, tiiny: v.tiiny || {}, ok: !!v.health?.tiiny?.ok, endpoints: v.endpoints || [] };
  } catch {
    return null;
  }
}

function modelFor(where) {
  if (process.env.DAEMONS_MODEL) return process.env.DAEMONS_MODEL;
  const size = (process.env.DAEMONS_TIINY_MODEL || "35b").toLowerCase();
  const m = TIINY_MODELS[size] || TIINY_MODELS["35b"];
  return m[where];
}

function pathModelFor(where) {
  if (process.env.DAEMONS_MODEL_PATHFINDING) return process.env.DAEMONS_MODEL_PATHFINDING;
  return TIINY_MODELS["9b"][where];
}

function asTiiny(why) {
  return { mind: "tiiny", why, baseURL: TIINY_URL, apiKey: tiinyKey(), model: modelFor("tiiny"),
           pathModel: pathModelFor("tiiny"), api: "chat", store: false };
}

function asSeer(why) {
  return { mind: "seer", why, baseURL: SEER_URL, apiKey: seerKey(), model: modelFor("seer"),
           pathModel: pathModelFor("seer"), api: "chat", store: false };
}

function asOpenRouter(why) {
  //  OpenRouter rejects the Responses API's `store` (bindDaemons.sh's or- rule), so it is off here as it was there.
  return { mind: "openrouter", why, baseURL: SEER_URL, apiKey: seerKey(),
           model: process.env.DAEMONS_MODEL || (/^or-/.test(process.env.OPENAI_MODEL || "") ? process.env.OPENAI_MODEL : OPENROUTER_DEFAULT),
           pathModel: process.env.DAEMONS_MODEL_PATHFINDING || "daemons-pathfinding", api: "responses", store: false };
}

//  The hub's choice, mapped onto a mind this harness can reach.
function viaHub() {
  const hub = askHub();
  if (!hub) return null;
  const url = String(hub.tiiny.url || "");
  if (hub.ok && url) {
    if (url.includes(`${SEER_HOST}:4000`)) return { ...asSeer(`the hub's mind is the Tiiny through LiteLLM (${url}), and it is well`), mind: "mind:seer" };
    if (url.includes("api.tiiny")) return { ...asTiiny(`the hub's mind is the Tiiny directly (${url}), and it is well`), mind: "mind:tiiny" };
    //  A mind at another address: its key stays in the hub's store and is never shown, so it can only be used keyless.
    return { mind: "mind:other", why: `the hub's mind is at ${url}`, baseURL: url, apiKey: "local", model: process.env.DAEMONS_MODEL || hub.tiiny.model,
             pathModel: process.env.DAEMONS_MODEL_PATHFINDING || hub.tiiny.quick || hub.tiiny.model, api: "chat", store: false };
  }
  return null;
}

function resolveMind(name = process.env.DAEMONS_MIND) {
  const want = String(name || "mind").toLowerCase();
  if (!MINDS.includes(want)) throw new Error(`DAEMONS_MIND=${name}: choose one of ${MINDS.join(", ")}`);
  if (want === "tiiny") return asTiiny("asked for directly");
  if (want === "seer") return asSeer("asked for directly");
  if (want === "openrouter") return asOpenRouter("asked for directly (paid)");
  //  mind: the hub's choice, else the Tiiny directly, else seer. Never OpenRouter: that costs money and must be asked for.
  const hub = viaHub();
  if (hub) return hub;
  if (answers(TIINY_URL)) return { ...asTiiny("the hub could not be asked or its mind was not well; the Tiiny answers directly"), mind: "mind:tiiny" };
  return { ...asSeer("neither the hub nor the Tiiny answered; trying seer"), mind: "mind:seer" };
}

//  Called once, before config.js reads the environment. DAEMONS_MIND unset AND OPENAI_BASE_URL set means the caller
//  configured an endpoint by hand (the old way, or upstream's api.openai.com): leave it alone.
function applyMind() {
  if (!process.env.DAEMONS_MIND && process.env.OPENAI_BASE_URL !== undefined) {
    process.env.DAEMONS_API = process.env.DAEMONS_API || "responses";
    return null;
  }
  const m = resolveMind();
  process.env.OPENAI_BASE_URL = m.baseURL;
  process.env.OPENAI_API_KEY = m.apiKey || "local";
  process.env.OPENAI_MODEL = m.model;
  process.env.OPENAI_MODEL_PATHFINDING = m.pathModel;
  process.env.DAEMONS_API = m.api;
  if (process.env.DAEMONS_STORE === undefined) process.env.DAEMONS_STORE = m.store ? "1" : "0";
  //  Thinking off on a chat mind unless asked for: the user's pick 2026-11-14, from docs/MINDS.md's measurements
  //  (35B, thinking off: 12 of 13 real turns a valid call, median 15 s). DAEMONS_THINK=1 turns it back on.
  if (m.api === "chat" && process.env.DAEMONS_THINK === undefined) process.env.DAEMONS_THINK = "0";
  process.env.DAEMONS_MIND_RESOLVED = m.mind;
  console.log(`[mind] ${m.mind}: ${m.model} at ${m.baseURL} (${m.api}) -- ${m.why}${m.apiKey ? "" : "; NO KEY FOUND"}`);
  return m;
}

module.exports = { applyMind, resolveMind, MINDS, TIINY_MODELS };
