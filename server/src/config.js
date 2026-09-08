const path = require("path");

// `__dirname` points to `server/src`; ROOT_DIR is `server/`
const ROOT_DIR = path.join(__dirname, "..");

const config = {
  wsPort: Number(process.env.WS_PORT || 9885),

  // --- OpenAI Configuration ---
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    //  DAEMONS: a ceiling on generation, because "high" reasoning against a
    //  local model is not the same trade as against a hosted one.
    //
    //  max_output_tokens was hardcoded to 32000 at every call site. On gpt-5.2
    //  that is a formality; on a 4-bit MiniCPM at ~70 tok/s it is a 457-second
    //  ceiling on ONE turn. A real turn here emits 180-1120 tokens, and the run
    //  that prompted this spent 290s emitting 21,190 -- 623 consecutive
    //  response.reasoning_text.delta events, thinking itself in circles and
    //  never reaching a tool call.
    //
    //  2048 is generous against the observed maximum and caps a runaway at
    //  ~30s instead of ~7.5 minutes. Raise it for a model that earns it.
    maxOutputTokens: Number(process.env.DAEMONS_MAX_OUTPUT_TOKENS || 32000),
    //  `store` asks the provider to retain the response for later retrieval.
    //  Upstream hardcodes true at four call sites, commented "Important to get
    //  call details in the final response" -- but the harness reads the final
    //  response out of the STREAM, not by fetching it back, so nothing here
    //  depends on retention.
    //
    //  OpenRouter rejects the request outright if it is true:
    //    invalid_value, path ["store"], "Invalid input: expected false"
    //
    //  and drop_params cannot save us, because `store` is a legitimate
    //  Responses parameter rather than an unsupported one -- it is passed
    //  through and refused. Default unchanged; bindDaemons turns it off for
    //  the providers that will not take it.
    store: (process.env.DAEMONS_STORE || "1") !== "0",
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "high",
    reasoningEffortBattle: process.env.OPENAI_REASONING_EFFORT_BATTLE || "high",
    reasoningEffortDialog: process.env.OPENAI_REASONING_EFFORT_DIALOG || "high",
    reasoningEffortCriticism: process.env.OPENAI_REASONING_EFFORT_CRITICISM || "high",
    reasoningEffortSummary: process.env.OPENAI_REASONING_EFFORT_SUMMARY || "xhigh",
    modelPathFinding: process.env.OPENAI_MODEL_PATHFINDING || "gpt-5.2",
    reasoningEffortPathfinding: process.env.OPENAI_REASONING_EFFORT_PATHFINDING || "high",
    reasoningSummary: process.env.OPENAI_REASONING_SUMMARY || "auto",

    tokenLimit: Number(process.env.OPENAI_TOKEN_LIMIT || 250000),
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 15 * 60 * 1000),
    service_tier: process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierSelfCriticism:
      process.env.OPENAI_SERVICE_TIER_SELF_CRITICISM || process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierSummary: process.env.OPENAI_SERVICE_TIER_SUMMARY || process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierPathfinding: process.env.OPENAI_SERVICE_TIER_PATHFINDING || "priority",

    tokenPrice: {
      "gpt-5.2": { input: 1.75, cached_input: 0.175, output: 14 },
      "gpt-5.1": { input: 1.25, cached_input: 0.125, output: 10 },
      "gpt-5": { input: 1.25, cached_input: 0.125, output: 10 },
      "gpt-4.1": { input: 2, cached_input: 0.5, output: 8 },
      "o4-mini": { input: 1.1, cached_input: 0.275, output: 4.4 },
      "o3": { input: 10, cached_input: 2.5, output: 40 },
    },
  },

  // --- Python Server Configuration (FireRed bridge) ---
  pythonServer: {
    baseUrl: process.env.PYTHON_BASE_URL || "http://127.0.0.1:8000",
    endpoints: {
      requestData: "/requestData",
      minimapSnapshot: "/minimapSnapshot",
      sendCommands: "/sendCommands",
      restartConsole: "/restartConsole",
    },
  },

  // --- Runtime Paths ---
  get dataDir() {
    return "gpt_data";
  },

  get promptsDir() {
    return path.join(ROOT_DIR, "prompts");
  },

  // --- File Paths ---
  paths: {
    baseDir: ROOT_DIR,

    get dataDir() {
      return config.dataDir;
    },

    get historySaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "history.json");
    },
    get memorySaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "memory.json");
    },
    get objectivesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "objectives.json");
    },
    get markersSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "markers.json");
    },
    get countersSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "counters.json");
    },
    get badgesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "badges_log.json");
    },
    get mapVisitsSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "map_visits.json");
    },
    get summariesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "summaries.json");
    },
    get allSummariesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "all_summaries.json");
    },
    //  The inner voice, kept with the run rather than in the browser. Living
    //  in the run's own data dir means --fresh clears it along with everything
    //  else it archives -- no separate rule, and no stale thoughts from a
    //  previous run reappearing under a new one.
    get asidesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "asides.json");
    },
    get progressStepsFile() {
      return path.join(ROOT_DIR, config.dataDir, "progress_steps.json");
    },
    get lastVisitedMapsFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_visited_maps.json");
    },
    get gameDataJsonFile() {
      return path.join(ROOT_DIR, config.dataDir, "game_data.json");
    },
    get lastCriticismSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_criticism.txt");
    },
    get tokenUsageFile() {
      return path.join(ROOT_DIR, config.dataDir, "token_usage.json");
    },
    get timeUsageFile() {
      return path.join(ROOT_DIR, config.dataDir, "time_usage.json");
    },
    get lastUserInputTextSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_userInputText_prompt.txt");
    },
  },

  // --- History Processing Configuration ---
  history: {
    //  The model's own thinking, replayed to it every turn. 105 of these were
    //  28.1% of an 882k-char prompt. Keep the recent train of thought, drop the
    //  rest. 0 disables reasoning history entirely.
    keepLastNReasoningItems: Number(process.env.DAEMONS_KEEP_REASONING || 2),
    keepLastNToolPartialResults: 20,
    keepLastNToolFullResults: 6,
    keepLastNUserMessagesWithMinimap: 1,
    keepLastNUserMessagesWithMemory: 1,
    keepLastNUserMessagesWithViewMap: 5,
    // DAEMONS: 10 turns of screenshots is 13 images and 486 KB of base64 in a
    // single request, and on a local VLM that is the whole cost -- one measured
    // decision took 279 SECONDS end to end. A frontier API absorbs that; a
    // model on one machine does not.
    //
    // The agent needs to see the screen it is acting on. Older screens are
    // already described in the text state and the explored map, so keeping ten
    // of them buys very little and pays for it every single step.
    // DAEMONS_KEEP_IMAGES raises it again for anyone who wants the old
    // behaviour.
    keepLastNUserMessagesWithImages: Number(process.env.DAEMONS_KEEP_IMAGES || 2),
    keepLastNUserMessagesWithDetailedData: 4,
    keepLastNUserMessagesWithPokedex: 1,
    //  DAEMONS: both were hardcoded, and 120 is further than most runs on a
    //  local model have ever got -- so the Summary panel was empty not because
    //  it was broken but because nothing had ever reached the trigger. It is
    //  worth being able to lower it to watch the thing work.
    limitAssistantMessagesForSelfCriticism: Number(process.env.DAEMONS_CRITIQUE_EVERY || 55),
    limitAssistantMessagesForSummary: Number(process.env.DAEMONS_SUMMARY_EVERY || 120),
  },

  // --- Tool Configuration ---
  tools: {
    strict: true,
  },

  // --- Loop Configuration ---
  loopDelayMs: 0,
};

module.exports = { config };
