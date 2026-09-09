(function () {
  "use strict";

  const MAX_LOG_ENTRIES = 500;
  const RECONNECT_DELAY_MS = 3000;
  const DEFAULT_POLL_MS = 800;
  const DEFAULT_HOST = window.location.hostname || "localhost";
  const DEFAULT_PORT = "9885";

  const KNOWN_POCKET_ORDER = [
    "item_pocket",
    "ball_pocket",
    "key_item_pocket",
    "tm_case",
    "berries_pocket",
  ];

  const FALLBACK_TILE = ["❓", "Unknown"];

  const ORIENTATION_SYMBOLS = {
    100: "🧍↓",
    101: "🧍↑",
    102: "🧍←",
    103: "🧍→",
  };

  const TILES = {
    0: ["⛔", "Wall (Collision/Impassable)"],
    1: ["🟫", "Free Ground"],
    2: ["🌿", "Tall Grass"],
    3: ["🌊", "Water"],
    4: ["💧↑", "Waterfall"],
    5: ["⛛→", "Ledge East"],
    6: ["⛛←", "Ledge West"],
    7: ["⛛↑", "Ledge North"],
    8: ["⛛↓", "Ledge South"],
    9: ["🌀", "Warp"],
    10: ["👤", "NPC (Collision)"],
    11: ["✨", "Interactive (Collision)"],
    14: ["🖥️", "PC (Collision)"],
    15: ["🗺️", "Region Map (Collision)"],
    16: ["📺", "Television (Collision)"],
    18: ["📚", "Bookshelf (Collision)"],
    21: ["🗑️", "Trash Can (Collision)"],
    22: ["🛒", "Shop Shelf (Collision)"],
    23: ["🟥", "Red Carpet"],
    24: ["⬜", "OOB (Walkable)"],
    25: ["⬛", "OOB (Collision)"],
    26: ["🚪", "Door"],
    27: ["🪜", "Ladder"],
    28: ["🛗", "Escalator"],
    29: ["🕳️", "Hole"],
    30: ["🧗", "Stairs"],
    31: ["🏔️", "Entrance"],
    32: ["➡️", "Warp Arrow"],
    33: ["🪨", "Boulder (Collision)"],
    35: ["🌳", "Cuttable Tree (Collision)"],
    36: ["🪨⛏️", "Breakable Rock (Collision)"],
    44: ["←", "Arrow Floor Left"],
    45: ["→", "Arrow Floor Right"],
    46: ["↑", "Arrow Floor Up"],
    47: ["↓", "Arrow Floor Down"],
    48: ["🧊", "Thin Ice"],
    49: ["🧊⚡", "Cracked Ice"],
    50: ["🌊←", "Water Current Left"],
    51: ["🌊→", "Water Current Right"],
    52: ["🌊↑", "Water Current Up"],
    53: ["🌊↓", "Water Current Down"],
    54: ["🌊🫧", "Dive Water"],
    55: ["🎁", "Item Ball (Collision)"],
    60: ["🌀→", "Spinner Right"],
    61: ["🌀←", "Spinner Left"],
    62: ["🌀↑", "Spinner Up"],
    63: ["🌀↓", "Spinner Down"],
    64: ["🌀⏹️", "Stop Spinner"],
    65: ["🔘", "Strength Switch"],
    66: ["🧱⏳", "Temporary Wall (Collision)"],
    67: ["🚪🔒", "Locked Door (Collision)"],
    68: ["🟫↑🚫", "Free Ground (North Edge Blocked)"],
    69: ["🟫↓🚫", "Free Ground (South Edge Blocked)"],
    70: ["🟫→🚫", "Free Ground (East Edge Blocked)"],
    71: ["🟫←🚫", "Free Ground (West Edge Blocked)"],
    72: ["🟫↑→🚫", "Free Ground (North+East Edges Blocked)"],
    73: ["🟫↑←🚫", "Free Ground (North+West Edges Blocked)"],
    74: ["🟫↓→🚫", "Free Ground (South+East Edges Blocked)"],
    75: ["🟫↓←🚫", "Free Ground (South+West Edges Blocked)"],
    140: ["🟫⚡", "Cracked Floor"],
  };

  const els = {
    hostInput: document.getElementById("host-input"),
    portInput: document.getElementById("port-input"),
    pollInput: document.getElementById("poll-input"),
    reconnectInput: document.getElementById("reconnect-input"),
    connectBtn: document.getElementById("connect-btn"),
    disconnectBtn: document.getElementById("disconnect-btn"),
    clearLogsBtn: document.getElementById("clear-logs-btn"),

    runtimeGrid: document.getElementById("runtime-grid"),
    trainerGrid: document.getElementById("trainer-grid"),
    teamList: document.getElementById("team-list"),
    inventoryWrap: document.getElementById("inventory-wrap"),
    objectivesWrap: document.getElementById("objectives-wrap"),
    progressWrap: document.getElementById("progress-wrap"),
    memoryWrap: document.getElementById("memory-wrap"),
    logList: document.getElementById("log-list"),
    summaryTitle: document.getElementById("summary-title"),
    criticismTitle: document.getElementById("criticism-title"),
    summaryStream: document.getElementById("summary-stream"),
    criticismStream: document.getElementById("criticism-stream"),
    minimapMeta: document.getElementById("minimap-meta"),
    minimapGrid: document.getElementById("minimap-grid"),
    minimapLegend: document.getElementById("minimap-legend"),
    markerList: document.getElementById("marker-list"),
  };

  const state = {
    settings: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      pollMs: DEFAULT_POLL_MS,
      autoReconnect: true,
    },
    ws: null,
    manualDisconnect: false,
    reconnectTimer: null,
    pollTimer: null,
    isConnected: false,
    lastWsAt: null,
    nextLogId: 1,
    logs: [],
    reasoningBuffer: "",
    reasoningFlushTimer: null,
    activeReasoningLogId: null,
    lastPollErrorMessage: "",

    game: {
      current_trainer_data: null,
      current_pokemon_data: [],
      inventory_data: {
        item_pocket: [],
        ball_pocket: [],
        key_item_pocket: [],
        tm_case: [],
        berries_pocket: [],
      },
      objectives: null,
      memory: {},
      markers: {},
      progressSteps: [],
      battle_data: null,
      remaining_until_criticism: 0,
      remaining_until_summary: 0,
      steps: 0,
      isThinking: false,
      isSummaryStep: false,
      isCriticismStep: false,
      visibility_reduced: false,
      visibility_window_width_tiles: null,
      visibility_window_height_tiles: null,
      safari_zone_counter: 0,
      safari_zone_active: false,
      last_summary: "",
      self_model: [],
      dreams: [],
      feelings: null,
      backchannel: [],
      feeling_events: [],
      last_criticism: "",
      total_tokens_accumulated: 0,
      time_usage_totals: { reasoning_ms: 0, tools_ms: 0, overall_ms: 0, down_ms: 0 },
    },
    tokenTotals: null,
    timeTotals: null,
    streams: {
      summaryText: "",
      criticismText: "",
      summaryInProgress: false,
      criticismInProgress: false,
    },
    minimap: {
      data: null,
      lastSeq: null,
      lastMarkersHash: "",
      markersByMap: {},
    },
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    return num.toLocaleString("en-US");
  }

  function formatTime(ts) {
    if (!Number.isFinite(ts)) return "-";
    return new Date(ts).toLocaleTimeString();
  }

  function formatMs(ms) {
    const num = Number(ms);
    if (!Number.isFinite(num) || num <= 0) return "0s";
    const totalSec = Math.floor(num / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function normalizeInventory(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        item_pocket: [],
        ball_pocket: [],
        key_item_pocket: [],
        tm_case: [],
        berries_pocket: [],
      };
    }

    const safePocket = (v) =>
      Array.isArray(v)
        ? v
            .filter((row) => Array.isArray(row) && row.length >= 2)
            .map((row) => [String(row[0] || ""), Number(row[1] || 0)])
        : [];

    const obj = raw;
    const out = {};
    for (const key of Object.keys(obj)) {
      out[key] = safePocket(obj[key]);
    }
    for (const key of KNOWN_POCKET_ORDER) {
      if (!out[key]) out[key] = [];
    }
    return out;
  }

  function buildWsUrl() {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${state.settings.host}:${state.settings.port}`;
  }

  function buildMinimapUrl() {
    const scheme = window.location.protocol === "https:" ? "https" : "http";
    return `${scheme}://${state.settings.host}:${state.settings.port}/minimapSnapshot`;
  }

  //  /speak lives on the HARNESS server, not on the page's own origin.
  //
  //  A relative "/speak" posts to whatever serves this file -- and that is
  //  `python -m http.server` on 5173, which implements GET and HEAD and
  //  nothing else. It answered POST with 501 Not Implemented, which the play
  //  button dutifully reported as "Voice unavailable (http_501)": a truthful
  //  message about the wrong server. Same host and port as the minimap, which
  //  had this right all along.
  function buildSpeakUrl() {
    const scheme = window.location.protocol === "https:" ? "https" : "http";
    return `${scheme}://${state.settings.host}:${state.settings.port}/speak`;
  }

  function setInputDefaults() {
    els.hostInput.value = state.settings.host;
    els.portInput.value = state.settings.port;
    els.pollInput.value = String(state.settings.pollMs);
    els.reconnectInput.checked = state.settings.autoReconnect;
  }

  function readSettingsFromInputs() {
    const host = String(els.hostInput.value || "").trim() || DEFAULT_HOST;
    const portNum = Number(els.portInput.value);
    const pollNum = Number(els.pollInput.value);

    state.settings.host = host;
    state.settings.port = Number.isFinite(portNum) && portNum > 0 ? String(Math.trunc(portNum)) : DEFAULT_PORT;
    state.settings.pollMs =
      Number.isFinite(pollNum) && pollNum >= 100 ? Math.trunc(pollNum) : DEFAULT_POLL_MS;
    state.settings.autoReconnect = Boolean(els.reconnectInput.checked);

    els.hostInput.value = state.settings.host;
    els.portInput.value = state.settings.port;
    els.pollInput.value = String(state.settings.pollMs);
  }

  function trimLogs() {
    while (state.logs.length > MAX_LOG_ENTRIES) {
      const removed = state.logs.shift();
      if (removed && removed.id === state.activeReasoningLogId) {
        state.activeReasoningLogId = null;
      }
    }
  }

  function addLog(type, message, options = {}) {
    const entry = {
      id: state.nextLogId++,
      type,
      message: typeof message === "string" ? message : "",
      data: options.data || null,
      status: options.status || null,
      callId: options.callId || null,
      ts: Date.now(),
    };
    state.logs.push(entry);
    trimLogs();
    renderLogs();
    return entry.id;
  }

  function queueReasoningChunk(chunk) {
    if (!chunk) return;
    state.reasoningBuffer += chunk;
    if (state.reasoningFlushTimer !== null) return;

    state.reasoningFlushTimer = window.setTimeout(flushReasoningBuffer, 80);
  }

  function flushReasoningBuffer() {
    if (state.reasoningFlushTimer !== null) {
      clearTimeout(state.reasoningFlushTimer);
      state.reasoningFlushTimer = null;
    }
    if (!state.reasoningBuffer) return;

    const buffered = state.reasoningBuffer;
    state.reasoningBuffer = "";

    const existing = state.logs.find((log) => log.id === state.activeReasoningLogId);
    if (!existing) {
      state.activeReasoningLogId = addLog("reasoning", buffered, { status: "streaming" });
      return;
    }

    existing.message += buffered;
    existing.ts = Date.now();
    renderLogs();
  }

  function closeReasoningStream() {
    flushReasoningBuffer();
    const existing = state.logs.find((log) => log.id === state.activeReasoningLogId);
    if (existing) {
      existing.status = "done";
    }
    state.activeReasoningLogId = null;
    renderLogs();
  }

  function summarizeAction(action) {
    if (!action || typeof action !== "object") return "Unknown action";
    const type = String(action.type || "unknown");
    if (type === "key_press") {
      const keys = Array.isArray(action.keys) ? action.keys.join(", ") : "";
      return `key_press: ${keys}`;
    }
    if (type === "path_to_location") {
      return `path_to_location -> (${action.x}, ${action.y}) on map ${action.map_id || "?"}`;
    }
    if (type === "add_marker") {
      return `add_marker ${action.emoji || ""} ${action.label || ""} @ (${action.x}, ${action.y}) map ${action.map_id || "?"}`;
    }
    if (type === "delete_marker") {
      return `delete_marker @ (${action.x}, ${action.y}) map ${action.map_id || "?"}`;
    }
    if (type === "write_memory") {
      return `write_memory: ${action.key || ""}`;
    }
    if (type === "delete_memory") {
      return `delete_memory: ${action.key || ""}`;
    }
    if (type === "update_objectives") {
      return "update_objectives";
    }
    if (type === "restart_console") {
      return "restart_console";
    }
    try {
      return `${type}: ${JSON.stringify(action)}`;
    } catch {
      return type;
    }
  }

  function parseCoordKey(key) {
    const [xRaw, yRaw] = String(key).split("_");
    return { x: Number(xRaw), y: Number(yRaw) };
  }

  function getCurrentMapMarkers(currentMapId) {
    const fromPoll = currentMapId ? state.minimap.markersByMap[currentMapId] : null;
    if (fromPoll && typeof fromPoll === "object" && !Array.isArray(fromPoll)) return fromPoll;

    const fromWs = currentMapId && state.game.markers ? state.game.markers[currentMapId] : null;
    if (fromWs && typeof fromWs === "object" && !Array.isArray(fromWs)) return fromWs;

    return {};
  }

  function pocketDisplayName(key) {
    return String(key || "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  //  DAEMONS: the inner voice, newest first, bounded.
  //
  //  Bounded because it is the one thing here nobody scrolls back through --
  //  you read the last few and move on. An unbounded list of them would be a
  //  memory leak in exchange for text nobody reads.
  const ASIDE_KEEP = 40;
  function pushAside(text) {
    if (!state.asides) state.asides = [];
    state.asides.unshift({ text, at: Date.now() });
    if (state.asides.length > ASIDE_KEEP) state.asides.length = ASIDE_KEEP;
    renderAsides();
  }

  //  Speaking an aside.
  //
  //  The audio is cached on the TEXT, not on the line, because the same
  //  thought recurs -- "I should heal before going further" is a thing this
  //  agent thinks repeatedly -- and the second time should be instant. The
  //  TTS server caches on a hash of text+voice for exactly the same reason,
  //  so a cache miss here is still often a hit there.
  //
  //  Bounded and REVOKED on eviction: an object URL holds its blob alive
  //  until you revoke it, so an unbounded map of them is a memory leak that
  //  grows by one mp3 per thought for as long as the run lasts.
  const VOICE_CACHE_MAX = 60;
  const voiceCache = new Map();   // text -> object URL
  let currentAudio = null;        // only one thought speaks at a time
  let currentSpeakingText = null;

  function cacheVoice(text, url) {
    voiceCache.set(text, url);
    while (voiceCache.size > VOICE_CACHE_MAX) {
      const oldest = voiceCache.keys().next().value;
      //  Never revoke the clip that is SPEAKING. Revoking an object URL kills
      //  the blob behind it, and <audio> reads from that blob as it plays --
      //  so evicting the playing entry would cut it off mid-sentence. It can
      //  only happen when the cache fills while something is playing, which is
      //  exactly the long unattended run this is for.
      if (oldest === currentSpeakingText) break;
      const stale = voiceCache.get(oldest);
      voiceCache.delete(oldest);
      if (stale) URL.revokeObjectURL(stale);
    }
  }

  //  Both panels can speak, so both have to redraw when playback moves --
  //  otherwise hushing a dream leaves the aside list showing a stale icon.
  //  One button, three panels. Written out twice was a coincidence; a third
  //  time is a function -- and it keeps the icon, the title and the four
  //  states from drifting apart between the lists that share a cache.
  function speakButton(text, attr, idx, restingLabel) {
    const speaking = currentSpeakingText === text;
    const loading = state.voiceLoading === text;
    const failed = state.voiceError && state.voiceError.text === text;
    const cached = voiceCache.has(text);
    const icon = loading ? "\u25CC" : speaking ? "\u25A0" : failed ? "\u26A0" : "\u25B6";
    const label = loading ? "Generating audio..."
      : speaking ? "Hush"
      : failed ? `Voice unavailable (${state.voiceError.reason})`
      : cached ? "Play (cached)"
      : restingLabel;
    return `<button class="aside-speak${speaking ? " on" : ""}${failed ? " failed" : ""}`
      + `${cached && !speaking && !failed ? " cached" : ""}"`
      + ` type="button" ${attr}="${idx}" title="${escapeHtml(label)}"`
      + ` aria-label="${escapeHtml(label)}"${loading ? " disabled" : ""}>${icon}</button>`;
  }

  function renderSpeakables() {
    renderAsides();
    renderDreams();
    renderSelf();
  }

  function stopSpeaking() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    currentSpeakingText = null;
    renderSpeakables();
  }

  async function speakText(text) {
    //  Clicking the line that is already speaking hushes it. That is the
    //  whole reason the icon changes -- the button has to mean what it shows.
    if (currentSpeakingText === text) { stopSpeaking(); return; }
    stopSpeaking();

    let url = voiceCache.get(text);
    if (!url) {
      state.voiceLoading = text;
      renderSpeakables();
      try {
        const res = await fetch(buildSpeakUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.audioBase64) {
          //  Name the failure on the line itself. A play button that goes
          //  quiet and stays quiet sends you looking at your speakers.
          state.voiceError = { text, reason: (data && data.error) || `http_${res.status}` };
          state.voiceLoading = null;
          renderSpeakables();
          return;
        }
        const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: data.audioMime || "audio/mpeg" }));
        cacheVoice(text, url);
      } catch (err) {
        state.voiceError = { text, reason: "unreachable" };
        state.voiceLoading = null;
        renderSpeakables();
        return;
      }
      state.voiceLoading = null;
      state.voiceError = null;
    }

    const audio = new Audio(url);
    audio.addEventListener("ended", stopSpeaking);
    audio.addEventListener("error", stopSpeaking);
    currentAudio = audio;
    currentSpeakingText = text;
    renderSpeakables();
    audio.play().catch(() => stopSpeaking());
  }

  //  Who it has decided it is. Written by `reflect`, and the thing the inner
  //  voice is supposed to sound like -- so it belongs on screen next to memory
  //  rather than only in the prompt, where nobody can check it against what
  //  the asides actually say.
  //  Its questions and my answers, oldest first -- this one is a conversation
  //  and reading it backwards would be perverse. An unanswered question is the
  //  thing to act on, so it is the one that stands out.
  function renderBackchannel() {
    const el = document.getElementById("bc-log");
    if (!el) return;
    const log = Array.isArray(state.game.backchannel) ? state.game.backchannel : [];
    if (!log.length) {
      el.innerHTML = '<div class="muted small">Nothing yet. It can ask you one '
        + 'question at a time; you can say anything, any time.</div>';
      return;
    }
    el.innerHTML = log.slice(-24).map((e) => {
      const agent = e.from === "agent";
      const open = agent && !e.answered;
      //  Whether it has actually landed. A message sits in this panel looking
      //  identical before and after the agent has seen it, which makes the one
      //  question you have of it -- did that get through? -- unanswerable.
      //  Both states are named rather than one: absence of a marker is a
      //  reading, and a reading is not a readout.
      const state_ = agent ? "" : (e.read ? "read" : "queued");
      return `<div class="bc-line ${agent ? "from-agent" : "from-guide"}${open ? " open" : ""}`
        + `${state_ ? " is-" + state_ : ""}"`
        + `${agent ? ` data-qid="${escapeHtml(e.id)}"` : ""}>`
        + `<span class="bc-who mono">${agent ? "it asks" : "you"}</span>`
        + `<span class="bc-text">${escapeHtml(String(e.text || ""))}</span>`
        + (open ? '<span class="bc-open mono">unanswered</span>' : "")
        + (state_ ? `<span class="bc-state mono">${state_}</span>` : "")
        + `</div>`;
    }).join("");
    el.scrollTop = el.scrollHeight;
  }

  //  Clicking an unanswered question aims the box at it, so a reply is
  //  attached to what it asked rather than floating loose.
  let bcReplyTo = null;
  document.addEventListener("click", (ev) => {
    const line = ev.target.closest && ev.target.closest(".bc-line.open");
    if (!line) return;
    bcReplyTo = line.getAttribute("data-qid");
    const input = document.getElementById("bc-input");
    if (input) { input.placeholder = "Answer its question\u2026"; input.focus(); }
  });

  function wireBackchannel() {
    const form = document.getElementById("bc-form");
    const input = document.getElementById("bc-input");
    if (!form || !input) return;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      input.disabled = true;
      try {
        const scheme = window.location.protocol === "https:" ? "https" : "http";
        await fetch(`${scheme}://${state.settings.host}:${state.settings.port}/backchannel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, replyTo: bcReplyTo }),
        });
        bcReplyTo = null;
        input.placeholder = "Say something to it\u2026";
      } catch (e) {
        //  Put it back rather than losing what was typed.
        input.value = text;
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
  }

  function renderSelf() {
    const el = document.getElementById("self-wrap");
    if (!el) return;
    const items = Array.isArray(state.game.self_model) ? state.game.self_model : [];
    if (!items.length) {
      el.innerHTML = '<div class="muted small">Nothing yet. This fills in when the agent '
        + 'reflects, which happens when it completes an objective.</div>';
      return;
    }
    el.innerHTML = items.map((s, i) => {
      const text = String(s.text || "");
      const speaking = currentSpeakingText === text;
      const n = Number(s.count) || 1;
      return `<div class="self-line${speaking ? " speaking" : ""}">`
        + speakButton(text, "data-self-index", i, "Hear this")
        + `<span class="self-step mono">step ${Number(s.step) || 0}</span>`
        //  INSIDE the text, not after it. As a sibling flex item it was pushed
        //  to the far edge of the panel by self-text's flex-grow, ending up a
        //  hand's width from the sentence it modifies -- which reads as a
        //  column of its own rather than as part of the line.
        + `<span class="self-text">${escapeHtml(text)}`
        + (n > 1 ? ` <span class="self-count mono" title="noticed ${n} times">&times;${n}</span>` : "")
        + `</span></div>`;
    }).join("");
  }

  //  Newest first, and only the last few. A dream is an impression; a scrollable
  //  archive of them stops being one.
  function renderDreams() {
    const el = document.getElementById("dreams-wrap");
    if (!el) return;
    const items = Array.isArray(state.game.dreams) ? state.game.dreams.slice().reverse() : [];
    if (!items.length) {
      el.innerHTML = '<div class="muted small">Nothing yet. A dream is written when a '
        + 'summary folds the history away.</div>';
      return;
    }
    el.innerHTML = items.slice(0, 4).map((d, i) => {
      const text = String(d.text || "");
      const speaking = currentSpeakingText === text;
      return `<div class="dream-line${i === 0 ? " latest" : ""}${speaking ? " speaking" : ""}">`
        + speakButton(text, "data-dream-index", i, "Hear this dream")
        + `<span class="self-step mono">step ${Number(d.step) || 0}</span>`
        + `<span class="dream-text">${escapeHtml(text)}</span></div>`;
    }).join("");
  }

  //  The four humor axes, above the voice they colour. Shown as signed bars
  //  rather than numbers: which way it leans and how far is the whole content,
  //  and "CHOLERIC: 43" says less than a bar that is clearly over halfway.
  //  Three intensities and one axis. Only PHLEGMATIC has a word at each end;
  //  the others rise from nothing, which is what the data actually does.
  const FEEL_AXES = {
    SANGUINE:    { hi: "GLAD", lo: null },
    CHOLERIC:    { hi: "MAD",  lo: null },
    MELANCHOLIC: { hi: "SAD",  lo: null },
    PHLEGMATIC:  { hi: "CALM", lo: "AFRAID" },
  };
  function renderFeelings() {
    const el = document.getElementById("feelings-bar");
    if (!el) return;
    const f = state.game.feelings;
    if (!f) { el.innerHTML = ""; return; }
    const why = (state.game.feeling_events || []).map((e) => e.why).join(", ");
    const rows = Object.entries(FEEL_AXES).map(([axis, spec]) => {
      const v = Math.max(-100, Math.min(100, Number(f[axis]) || 0));
      //  A quiet axis keeps its name and dims -- below 8, the same threshold
      //  the prompt uses to decide a feeling is not worth mentioning.
      const quiet = Math.abs(v) < 8;
      const two = Boolean(spec.lo);
      //  Two-sided: fills out from the centre, a word at each end, so the
      //  direction is legible without a legend. One-sided: fills from the
      //  left edge across the whole track, because there is no other side.
      const pct = two ? Math.abs(v) / 2 : Math.max(0, v);
      const side = two ? (v >= 0 ? "left:50%" : "right:50%") : "left:0";
      return `<div class="feel-row${quiet ? " quiet" : ""}${two ? " two-sided" : ""}"`
        + ` title="${escapeHtml(axis)} ${v}">`
        + `<span class="feel-name mono">${escapeHtml(two ? spec.lo : spec.hi)}</span>`
        + `<span class="feel-track"><i class="feel-fill${v < 0 ? " neg" : ""}"`
        + ` style="${side};width:${pct}%"></i></span>`
        + `<span class="feel-name feel-name-right mono">${two ? escapeHtml(spec.hi) : ""}</span></div>`;
    }).join("");
    //  BOREDOM sits apart, because it is not a humor. Four of these map onto
    //  the Review Board and this one does not -- putting it in the same block
    //  would quietly claim a fifth member. Its own row, under its own rule,
    //  and it says what it makes you WANT rather than what it measures.
    const b = Math.max(0, Math.min(100, Number(f.BOREDOM) || 0));
    const bWant = b >= 70 ? "sick of this — anything is better than another turn of nothing"
      : b >= 45 ? "going over the same ground too long"
      : b >= 20 ? "nothing has happened for a while"
      : "";
    const bored =
      `<div class="feel-row drive${b < 20 ? " quiet" : ""}" title="BOREDOM ${b}">`
      + `<span class="feel-name mono">RESTLESS</span>`
      + `<span class="feel-track"><i class="feel-fill drive-fill" style="left:0;width:${b}%"></i></span>`
      + `<span class="feel-name feel-name-right mono"></span></div>`
      + (bWant ? `<div class="feel-want muted small">${escapeHtml(bWant)}</div>` : "");

    el.innerHTML = rows + bored + (why
      ? `<div class="feel-why muted small">${escapeHtml(why)}</div>` : "");
  }

  function renderAsides() {
    const el = document.getElementById("aside-stream");
    if (!el) return;
    if (!state.asides || !state.asides.length) {
      el.innerHTML = '<div class="muted small">No asides yet.</div>';
      return;
    }
    el.innerHTML = state.asides.map((a, i) => {
      const speaking = currentSpeakingText === a.text;
      return `<div class="aside-line${i === 0 ? " latest" : ""}${speaking ? " speaking" : ""}">`
        + speakButton(a.text, "data-aside-index", i, "Speak this thought")
        + `<span class="aside-time mono">${formatTime(a.at)}</span>`
        + `<span class="aside-text">${escapeHtml(a.text)}</span></div>`;
    }).join("");
  }

  //  Delegated, and bound once: renderAsides() replaces this subtree on every
  //  new thought, so a listener attached to a button would not survive the
  //  next one.
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest && ev.target.closest(".aside-speak");
    if (!btn) return;
    //  Two panels, one handler. Dreams are rendered newest-first and sliced,
    //  so the index is into that same reversed view rather than the raw array.
    if (btn.hasAttribute("data-self-index")) {
      const items = Array.isArray(state.game.self_model) ? state.game.self_model : [];
      const e = items[Number(btn.getAttribute("data-self-index"))];
      if (e && e.text) speakText(String(e.text));
      return;
    }
    if (btn.hasAttribute("data-dream-index")) {
      const dreams = Array.isArray(state.game.dreams) ? state.game.dreams.slice().reverse() : [];
      const d = dreams[Number(btn.getAttribute("data-dream-index"))];
      if (d && d.text) speakText(String(d.text));
      return;
    }
    const idx = Number(btn.getAttribute("data-aside-index"));
    const entry = state.asides && state.asides[idx];
    if (entry) speakText(entry.text);
  });

  //  Tabs. The panels behind them are consulted occasionally; the ones left
  //  on screen are the ones actually watched. Wired once at load, since the
  //  panes exist in the document from the start and only visibility changes.
  //  Three states, not two: auto follows the OS, light and dark pin it. A
  //  two-state toggle cannot express "whatever the machine is doing", which is
  //  what most people want most of the time and what the CSS already does when
  //  nothing is stamped on the root.
  const THEMES = ["auto", "light", "dark"];
  function applyTheme(name) {
    const root = document.documentElement;
    if (name === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", name);
    const btn = document.getElementById("theme-btn");
    if (btn) btn.textContent = "Theme: " + name;
    try { localStorage.setItem("daemons.theme", name); } catch (e) { /* private window */ }
  }

  function initTheme() {
    let saved = "auto";
    try { saved = localStorage.getItem("daemons.theme") || "auto"; } catch (e) { /* ignore */ }
    if (!THEMES.includes(saved)) saved = "auto";
    applyTheme(saved);
    const btn = document.getElementById("theme-btn");
    if (btn) btn.addEventListener("click", () => {
      const cur = document.getElementById("theme-btn").textContent.replace("Theme: ", "");
      applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    });
  }

  function initTabs() {
    const bar = document.querySelector(".tabbar");
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button.tab");
      if (!btn) return;
      const want = btn.dataset.tab;
      bar.querySelectorAll("button.tab").forEach((b) =>
        b.setAttribute("aria-selected", String(b.dataset.tab === want)));
      document.querySelectorAll(".tabpane").forEach((p) => {
        p.hidden = p.dataset.pane !== want;
      });
    });
  }

  //  The last four frames, newest first. Cache-busted because the files keep
  //  their names as they rotate, and the browser would otherwise show the
  //  first one it ever saw.
  //
  //  Loaded through a probe Image so a frame that does not exist yet -- early
  //  in a run, before the history has filled -- simply does not appear,
  //  instead of rendering as a broken image.
  const FRAMES = ["latest-frame.png", "frame-1.png", "frame-2.png", "frame-3.png"];
  function refreshFrame() {
    const strip = document.getElementById("frame-strip");
    if (!strip) return;
    const stamp = Date.now();
    FRAMES.forEach((name, i) => {
      const src = name + "?t=" + stamp;
      const probe = new Image();
      probe.onload = () => {
        let fig = strip.querySelector(`[data-frame="${i}"]`);
        if (!fig) {
          fig = document.createElement("figure");
          fig.className = "frame-item";
          fig.dataset.frame = String(i);
          fig.innerHTML = '<img alt="" /><figcaption class="muted small"></figcaption>';
          //  Insert in order, so a late-arriving older frame does not jump the queue.
          const after = Array.from(strip.children).find((c) => Number(c.dataset.frame) > i);
          strip.insertBefore(fig, after || null);
        }
        fig.querySelector("img").src = src;
        fig.querySelector("figcaption").textContent = i === 0 ? "latest" : `${i} turn${i > 1 ? "s" : ""} ago`;
        if (i === 0) {
          const age = document.getElementById("frame-age");
          if (age) age.textContent = "· " + formatTime(stamp);
        }
      };
      probe.src = src;
    });
  }

  //  Click any frame to see it full size.
  function initFrameView() {
    const strip = document.getElementById("frame-strip");
    const dlg = document.getElementById("frame-view");
    if (!strip || !dlg) return;
    strip.addEventListener("click", (e) => {
      const fig = e.target.closest(".frame-item");
      if (!fig) return;
      document.getElementById("frame-view-img").src = fig.querySelector("img").src;
      document.getElementById("frame-view-cap").textContent = fig.querySelector("figcaption").textContent;
      dlg.showModal();
    });
    //  Click the backdrop to dismiss. Escape is handled by <dialog> itself.
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }

  function renderRuntime() {
    const tokenTotals = state.tokenTotals || {};
    const timeTotals = state.timeTotals || state.game.time_usage_totals || {};
    const g = state.game;
    const connBadge = state.isConnected
      ? `<span class="badge ok">Connected</span>`
      : `<span class="badge err">Disconnected</span>`;
    const thinkingBadge = g.isThinking
      ? `<span class="badge warn">Thinking</span>`
      : `<span class="badge">Idle</span>`;

    //  DAEMONS: the run's score, with its arithmetic in the title attribute.
    //  A bare number nobody can check is a number nobody trusts -- and this one
    //  is a guess at what "doing well" means, so it will need tweaking. Showing
    //  the working is how it gets tweaked from evidence instead of from taste.
    const p = state.game.progress;
    let scoreCell = '<span class="muted">--</span>';
    if (p && p.parts) {
      const w = p.weights || {};
      const q = p.parts;
      const rows = [
        ["badges", q.badges, w.badge],
        ["maps seen", q.maps, w.map],
        ["party levels", q.partyLevels, w.partyLevel],
        ["caught", q.caught, w.caught],
        ["seen", q.seen, w.seen],
        ["money", q.money, w.money],
      ];
      const tip = "score = sum of each count x its weight\n\n"
        + rows.map(([n, c, wt]) =>
            `${String(n).padEnd(13)} ${String(c ?? 0).padStart(6)} x ${wt} = ${Math.round((c || 0) * wt)}`
          ).join("\n")
        + `\n${"".padEnd(13)} ${"".padStart(6)}     total ${p.score}`
        + "\n\nBadges dominate on purpose: eight of them IS the game."
        + "\nMoney is deliberately weak -- 1000 currency is 2 points."
        + "\nThe model never sees this number, only the delta in words.";
      scoreCell = `<span class="score" title="${escapeHtml(tip)}">${formatNumber(p.score)}</span>`
        + (p.delta ? ` <span class="muted small">${escapeHtml(p.delta)}</span>` : "");
    }

    const lines = [
      ["Connection", `${connBadge} ${thinkingBadge}`],
      ["Progress score", scoreCell],
      ["WS URL", `<span class="mono">${escapeHtml(buildWsUrl())}</span>`],
      ["Last WS message", formatTime(state.lastWsAt)],
      ["Step", formatNumber(g.steps)],
      ["Summary step", g.isSummaryStep ? `<span class="badge warn">Yes</span>` : "No"],
      ["Criticism step", g.isCriticismStep ? `<span class="badge warn">Yes</span>` : "No"],
      ["Until summary", formatNumber(g.remaining_until_summary || 0)],
      ["Until criticism", formatNumber(g.remaining_until_criticism || 0)],
      ["Total tokens", formatNumber(tokenTotals.total_tokens || g.total_tokens_accumulated || 0)],
      ["Total cost", `$${Number(tokenTotals.discounted_cost || 0).toFixed(4)}`],
      ["Reasoning time", formatMs(timeTotals.reasoning_ms || 0)],
      ["Tools time", formatMs(timeTotals.tools_ms || 0)],
      ["Overall time", formatMs(timeTotals.overall_ms || 0)],
      ["Down time", formatMs(timeTotals.down_ms || 0)],
      ["Safari active", g.safari_zone_active ? "Yes" : "No"],
      ["Safari steps", formatNumber(g.safari_zone_counter || 0)],
    ];

    els.runtimeGrid.innerHTML = lines
      .map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`)
      .join("");
  }

  function renderTrainer() {
    const t = state.game.current_trainer_data;
    if (!t || typeof t !== "object") {
      els.trainerGrid.innerHTML = `<div class="muted">Waiting for trainer data...</div>`;
      return;
    }

    const pos = t.position || {};
    const badges = t.badges && typeof t.badges === "object" ? t.badges : {};
    const badgeNames = Object.keys(badges).filter((k) => Boolean(badges[k]));

    const lines = [
      ["Name", escapeHtml(t.name || "PLAYER")],
      ["Cache", `¥${formatNumber(t.money || 0)}`],
      ["Map", `${escapeHtml(pos.map_name || "-")} <span class="muted">(${escapeHtml(pos.map_id || "-")})</span>`],
      ["Position", `<span class="mono">X=${formatNumber(pos.x)} Y=${formatNumber(pos.y)}</span>`],
      ["Marks", formatNumber(t.badge_count || badgeNames.length)],
      [
        "Flags",
        [
          state.game.flash_needed ? `<span class="badge warn">Flash Needed</span>` : "",
          state.game.flash_active ? `<span class="badge ok">Flash Active</span>` : "",
          state.game.visibility_reduced ? `<span class="badge warn">Reduced Visibility</span>` : "",
          state.game.is_talking_to_npc ? `<span class="badge warn">In Dialog</span>` : "",
          state.game.battle_data?.in_battle ? `<span class="badge err">In Battle</span>` : "",
        ]
          .filter(Boolean)
          .join(" "),
      ],
      [
        "Marks list",
        badgeNames.length > 0
          ? badgeNames.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")
          : `<span class="muted">None</span>`,
      ],
    ];

    els.trainerGrid.innerHTML = lines
      .map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`)
      .join("");
  }

  function renderTeam() {
    const team = Array.isArray(state.game.current_pokemon_data) ? state.game.current_pokemon_data : [];
    const battle = state.game.battle_data || {};
    const activeIndices = new Set(
      Array.isArray(battle.party_indices)
        ? battle.party_indices.map((v) => Number(v))
        : Number.isFinite(Number(battle.party_index))
          ? [Number(battle.party_index)]
          : []
    );

    if (team.length === 0) {
      els.teamList.innerHTML = `<div class="muted">No team data yet.</div>`;
      return;
    }

    els.teamList.innerHTML = team
      .map((p, idx) => {
        const maxHp = Number(p.max_hp || 0);
        const curHp = Number(p.current_hp || 0);
        const hpPct = maxHp > 0 ? Math.max(0, Math.min(100, (curHp / maxHp) * 100)) : 0;
        const hpClass = hpPct <= 20 ? "critical" : hpPct <= 50 ? "low" : "";
        const inBattle = Boolean(state.game.battle_data?.in_battle) && activeIndices.has(idx);

        const moves = Array.isArray(p.moves) ? p.moves : [];
        const moveRows =
          moves.length > 0
            ? `<ul class="moves">${moves
                .map((m) => `<li>${escapeHtml(m.name || "?")} <span class="muted">PP ${formatNumber(m.pp || 0)}</span></li>`)
                .join("")}</ul>`
            : `<div class="muted">No moves</div>`;

        return `
          <article class="pokemon-card">
            <div class="pokemon-head">
              <div>
                <div class="pokemon-name">${escapeHtml(p.nickname || p.species_name || "Unknown")}</div>
                <div class="pokemon-sub">${escapeHtml(p.species_name || "Unknown")} • Lv ${formatNumber(p.level || 0)}</div>
              </div>
              <div>
                ${inBattle ? `<span class="badge warn">Active in battle</span>` : ""}
                ${p.status ? `<span class="badge err">${escapeHtml(p.status)}</span>` : ""}
                ${p.is_shiny ? `<span class="badge ok">Shiny</span>` : ""}
              </div>
            </div>
            <div class="hp-row">
              <div class="hp-track"><div class="hp-fill ${hpClass}" style="width:${hpPct}%"></div></div>
              <div class="hp-label">${formatNumber(curHp)} / ${formatNumber(maxHp)} HP</div>
            </div>
            <div class="pokemon-sub">Types: ${Array.isArray(p.types) && p.types.length > 0 ? p.types.map((t) => escapeHtml(t)).join(", ") : "?"}</div>
            ${moveRows}
          </article>
        `;
      })
      .join("");
  }

  function renderInventory() {
    const inventory = normalizeInventory(state.game.inventory_data);
    const pockets = Object.keys(inventory).sort((a, b) => {
      const ia = KNOWN_POCKET_ORDER.indexOf(a);
      const ib = KNOWN_POCKET_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    els.inventoryWrap.innerHTML = pockets
      .map((pocketKey) => {
        const items = Array.isArray(inventory[pocketKey]) ? inventory[pocketKey] : [];
        const rows =
          items.length > 0
            ? `<table class="table-lite"><tbody>${items
                .map(
                  (item) => `
                  <tr>
                    <td>${escapeHtml(item[0] || "")}</td>
                    <td class="mono" style="text-align:right;">x${formatNumber(item[1] || 0)}</td>
                  </tr>
                `
                )
                .join("")}</tbody></table>`
            : `<div class="muted">Empty</div>`;

        return `
          <article class="pocket-card">
            <h4>${escapeHtml(pocketDisplayName(pocketKey))} <span class="muted">(${formatNumber(items.length)})</span></h4>
            ${rows}
          </article>
        `;
      })
      .join("");
  }

  function renderObjectives() {
    const obj = state.game.objectives;
    if (!obj || typeof obj !== "object") {
      els.objectivesWrap.innerHTML = `<div class="muted">No objectives yet.</div>`;
      return;
    }

    const renderObjectiveBlock = (title, value) => {
      if (!value || typeof value !== "object") {
        return `<article class="objective-card"><h4>${escapeHtml(title)}</h4><div class="muted">Not set</div></article>`;
      }
      return `
        <article class="objective-card">
          <h4>${escapeHtml(title)}</h4>
          <div><strong>${escapeHtml(value.short_description || "-")}</strong></div>
          <div class="muted">${escapeHtml(value.description || "")}</div>
        </article>
      `;
    };

    const others = Array.isArray(obj.others) ? obj.others : [];
    const othersHtml =
      others.length > 0
        ? others
            .map(
              (it, idx) => `
            <article class="objective-card">
              <h4>Other ${idx + 1}</h4>
              <div><strong>${escapeHtml(it.short_description || "-")}</strong></div>
              <div class="muted">${escapeHtml(it.description || "")}</div>
            </article>
          `
            )
            .join("")
        : `<article class="objective-card"><h4>Others</h4><div class="muted">No extra objectives.</div></article>`;

    els.objectivesWrap.innerHTML =
      renderObjectiveBlock("Primary", obj.primary) +
      renderObjectiveBlock("Secondary", obj.secondary) +
      renderObjectiveBlock("Third", obj.third) +
      othersHtml;
  }

  function renderProgress() {
    const steps = Array.isArray(state.game.progressSteps) ? state.game.progressSteps : [];
    if (steps.length === 0) {
      els.progressWrap.innerHTML = `<div class="muted">No progress data yet.</div>`;
      return;
    }

    const doneCount = steps.filter((s) => s && s.done).length;
    const pct = Math.max(0, Math.min(100, (doneCount / steps.length) * 100));

    const items = steps
      .map((step) => {
        const done = Boolean(step?.done);
        return `
          <div class="progress-item ${done ? "done" : ""}">
            <div>
              <div>${done ? "✅" : "⬜"} ${escapeHtml(step?.label || step?.id || "Unnamed step")}</div>
              <div class="meta">${escapeHtml(step?.type || "?")} • trigger: ${escapeHtml(step?.trigger || "?")}</div>
            </div>
            <div class="meta">${escapeHtml(step?.done_on || "")}</div>
          </div>
        `;
      })
      .join("");

    els.progressWrap.innerHTML = `
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="muted" style="margin-bottom: 0.4rem;">${formatNumber(doneCount)} / ${formatNumber(
        steps.length
      )} steps done (${pct.toFixed(1)}%)</div>
      ${items}
    `;
  }

  function renderMemory() {
    const memory = state.game.memory && typeof state.game.memory === "object" ? state.game.memory : {};
    const keys = Object.keys(memory).sort((a, b) => a.localeCompare(b));
    if (keys.length === 0) {
      els.memoryWrap.innerHTML = `<div class="muted">Memory is empty.</div>`;
      return;
    }

    els.memoryWrap.innerHTML = keys
      .map(
        (key) => `
        <article class="memory-item">
          <div><strong>${escapeHtml(key)}</strong></div>
          <div class="muted">${escapeHtml(String(memory[key] ?? ""))}</div>
        </article>
      `
      )
      .join("");
  }

  function renderStreams() {
    els.summaryTitle.textContent = state.streams.summaryInProgress
      ? "Summary (streaming...)"
      : "Summary";
    els.criticismTitle.textContent = state.streams.criticismInProgress
      ? "Criticism (streaming...)"
      : "Criticism";

    const summaryFallback = state.game.last_summary || "";
    const criticismFallback = state.game.last_criticism || "";
    //  An empty panel is not information. These two have read as broken for
    //  days -- one because the first summary had not happened yet, the other
    //  because self-critique is off by default -- and nothing on screen told
    //  the difference between "off", "not yet" and "failing". Say which.
    const g = state.game || {};
    els.summaryStream.textContent =
      state.streams.summaryText || summaryFallback
      || (Number.isFinite(g.remaining_until_summary) && g.remaining_until_summary > 0
            ? `Nothing summarised yet. The first one runs in ${g.remaining_until_summary} step${g.remaining_until_summary === 1 ? "" : "s"}.`
            : "Nothing summarised yet.");
    els.criticismStream.textContent =
      state.streams.criticismText || criticismFallback
      || (g.self_critique_enabled === false
            ? "Self-critique is OFF. It produced confidently wrong readings on local "
              + "models -- \"no loops detected\" during an hour of walking into the same "
              + "wall -- and its output is injected into every prompt until the next "
              + "one. Set DAEMONS_SELF_CRITIQUE=1 to turn it back on."
            : Number.isFinite(g.remaining_until_criticism) && g.remaining_until_criticism > 0
              ? `No critique yet. The next one runs in ${g.remaining_until_criticism} step${g.remaining_until_criticism === 1 ? "" : "s"}.`
              : "No critique yet.");
  }

  function renderMinimap() {
    const mm = state.minimap.data;
    if (!mm || !Array.isArray(mm.grid) || mm.grid.length === 0 || !Array.isArray(mm.grid[0])) {
      els.minimapMeta.innerHTML = `<span class="muted">No minimap snapshot yet.</span>`;
      els.minimapGrid.innerHTML = "";
      els.minimapLegend.innerHTML = `<div class="muted">No tiles.</div>`;
      els.markerList.innerHTML = `<div class="muted">No markers.</div>`;
      return;
    }

    const grid = mm.grid;
    const height = Number.isFinite(Number(mm.height)) ? Number(mm.height) : grid.length;
    const width =
      Number.isFinite(Number(mm.width)) && Number(mm.width) > 0 ? Number(mm.width) : grid[0].length;

    const mapId =
      typeof mm.map_id === "string"
        ? mm.map_id
        : state.game.current_trainer_data?.position?.map_id || null;
    const mapName =
      typeof mm.map_name === "string"
        ? mm.map_name
        : state.game.current_trainer_data?.position?.map_name || "-";
    const playerX = Number(mm.player_x);
    const playerY = Number(mm.player_y);
    const orientation = Number(mm.orientation);
    const markers = getCurrentMapMarkers(mapId);

    const usedTileIds = new Set();
    const tiles = [];

    for (let y = 0; y < height; y++) {
      const row = Array.isArray(grid[y]) ? grid[y] : [];
      for (let x = 0; x < width; x++) {
        const rawId = row[x];
        const id = rawId === null || rawId === undefined ? null : Number(rawId);
        if (id !== null && Number.isFinite(id)) usedTileIds.add(id);

        const tileDef = id !== null && Number.isFinite(id) && TILES[id] ? TILES[id] : FALLBACK_TILE;
        let symbol = tileDef[0];
        let tileClass = "tile";

        if (x === playerX && y === playerY) {
          symbol = ORIENTATION_SYMBOLS[orientation] || "🧍";
          tileClass += " tile-player";
        } else if (id === null || !Number.isFinite(id)) {
          tileClass += " tile-unknown";
        }

        const marker = markers[`${x}_${y}`];
        if (marker && typeof marker === "object" && marker.emoji) {
          symbol = `${symbol}${String(marker.emoji)}`;
        }

        const markerTitle =
          marker && typeof marker === "object"
            ? ` | Marker: ${String(marker.emoji || "")} ${String(marker.label || "")}`
            : "";
        const title = `${x},${y} | ${tileDef[1]}${markerTitle}`;

        tiles.push(`<div class="${tileClass}" title="${escapeHtml(title)}">${escapeHtml(symbol)}</div>`);
      }
    }

    els.minimapGrid.style.gridTemplateColumns = `repeat(${width}, var(--tile-size))`;
    els.minimapGrid.innerHTML = tiles.join("");

    els.minimapMeta.innerHTML = [
      `Map: <strong>${escapeHtml(mapName)}</strong>`,
      mapId ? `ID: <span class="mono">${escapeHtml(mapId)}</span>` : "",
      `Size: <span class="mono">${formatNumber(width)}x${formatNumber(height)}</span>`,
      `Player: <span class="mono">X=${formatNumber(playerX)} Y=${formatNumber(playerY)}</span>`,
      Number.isFinite(Number(mm.seq)) ? `Seq: ${formatNumber(mm.seq)}` : "",
      Number.isFinite(Number(mm.updatedAtMs)) ? `Updated: ${formatTime(Number(mm.updatedAtMs))}` : "",
      state.game.visibility_reduced ? `<span class="badge warn">Reduced visibility</span>` : "",
    ]
      .filter(Boolean)
      .join(" • ");

    const legendRows = [...usedTileIds]
      .sort((a, b) => a - b)
      .map((id) => {
        const [sym, desc] = TILES[id] || FALLBACK_TILE;
        return `<div class="line"><span>${escapeHtml(sym)}</span><span class="mono">(${id})</span><span>${escapeHtml(desc)}</span></div>`;
      });
    legendRows.unshift(`<div class="line"><span>🧍</span><span>Player</span></div>`);
    legendRows.push(`<div class="line"><span>❓</span><span>Unknown/Fog</span></div>`);
    els.minimapLegend.innerHTML =
      legendRows.length > 0 ? legendRows.join("") : `<div class="muted">No legend data.</div>`;

    const markerKeys = Object.keys(markers).sort((a, b) => {
      const aa = parseCoordKey(a);
      const bb = parseCoordKey(b);
      if (aa.y !== bb.y) return aa.y - bb.y;
      return aa.x - bb.x;
    });
    els.markerList.innerHTML =
      markerKeys.length > 0
        ? markerKeys
            .map((key) => {
              const marker = markers[key] || {};
              const coords = parseCoordKey(key);
              return `<div class="line"><span>${escapeHtml(String(marker.emoji || ""))}</span><span>${escapeHtml(
                String(marker.label || "")
              )}</span><span class="mono">(${coords.x},${coords.y})</span></div>`;
            })
            .join("")
        : `<div class="muted">No markers on current map.</div>`;
  }

  function renderLogs() {
    if (!Array.isArray(state.logs) || state.logs.length === 0) {
      els.logList.innerHTML = `<div class="muted">No logs yet.</div>`;
      return;
    }

    const html = state.logs
      .map((entry) => {
        const typeClass =
          entry.type === "chat"
            ? "chat"
            : entry.type === "reasoning"
              ? "reasoning"
              : entry.type === "action"
                ? "action"
                : entry.type === "error"
                  ? "error"
                  : "status";
        const statusBadge = entry.status
          ? `<span class="badge ${entry.status === "error" ? "err" : entry.status === "pending" ? "warn" : "ok"}">${escapeHtml(
              entry.status
            )}</span>`
          : "";

        let body = "";
        if (entry.type === "action") {
          const action = entry.data?.action;
          const summary = summarizeAction(action);
          const message = entry.data?.message || entry.message || "";
          const details = entry.data?.details;
          body = `
            <div><strong>${escapeHtml(summary)}</strong></div>
            ${message ? `<div class="text-block">${escapeHtml(message)}</div>` : ""}
            ${
              details
                ? `<details><summary>details</summary><pre class="stream-box" style="max-height:130px;">${escapeHtml(
                    String(details)
                  )}</pre></details>`
                : ""
            }
          `;
        } else if (entry.type === "chat") {
          const emotion = entry.data?.avatar_emotion ? ` <span class="badge">${escapeHtml(entry.data.avatar_emotion)}</span>` : "";
          body = `<div class="text-block">${escapeHtml(entry.message)}${emotion}</div>`;
        } else {
          body = `<div class="text-block">${escapeHtml(entry.message)}</div>`;
        }

        return `
          <article class="log-entry ${typeClass}">
            <div class="head">
              <div class="type">${escapeHtml(entry.type)}</div>
              <div>
                ${statusBadge}
                <span class="time">${formatTime(entry.ts)}</span>
              </div>
            </div>
            ${body}
          </article>
        `;
      })
      .join("");

    els.logList.innerHTML = html;
    els.logList.scrollTop = els.logList.scrollHeight;
  }

  function renderAllPanels() {
    renderRuntime();
    renderTrainer();
    renderTeam();
    renderInventory();
    renderObjectives();
    renderProgress();
    renderMemory();
    renderStreams();
    renderMinimap();
    renderLogs();
    renderBackchannel();
  }

  function mergeFullState(payload) {
    if (!payload || typeof payload !== "object") return;
    const merged = {
      ...state.game,
      ...payload,
      inventory_data: normalizeInventory(payload.inventory_data),
    };
    state.game = merged;

    if (payload.markers && typeof payload.markers === "object") {
      state.game.markers = payload.markers;
    }
    //  Seed the inner voice from the server on connect. `pushAside` unshifts
    //  newest-first; the server keeps them oldest-first, hence the reverse.
    //
    //  Only when the panel is EMPTY: full_state arrives on every step, and
    //  re-seeding each time would fight the live pushes and clobber the cache
    //  keys the play buttons are keyed on.
    if (Array.isArray(payload.asides) && (!state.asides || !state.asides.length)) {
      state.asides = payload.asides
        .slice(-ASIDE_KEEP)
        .map((a) => ({ text: String(a.text || ""), at: Number(a.at) || Date.now() }))
        .filter((a) => a.text)
        .reverse();
      renderAsides();
    }
    if (Array.isArray(payload.self_model)) {
      state.game.self_model = payload.self_model;
      renderSelf();
    }
    if (Array.isArray(payload.backchannel)) {
      state.game.backchannel = payload.backchannel;
      renderBackchannel();
    }
    if (payload.feelings && typeof payload.feelings === "object") {
      state.game.feelings = payload.feelings;
      state.game.feeling_events = payload.feeling_events || [];
      renderFeelings();
    }
    if (Array.isArray(payload.dreams)) {
      state.game.dreams = payload.dreams;
      renderDreams();
    }
    if (typeof payload.self_critique_enabled === "boolean") {
      state.game.self_critique_enabled = payload.self_critique_enabled;
    }
    if (!state.streams.summaryInProgress && typeof payload.last_summary === "string") {
      state.streams.summaryText = payload.last_summary;
    }
    if (!state.streams.criticismInProgress && typeof payload.last_criticism === "string") {
      state.streams.criticismText = payload.last_criticism;
    }

    renderRuntime();
    renderTrainer();
    renderTeam();
    renderInventory();
    renderObjectives();
    renderProgress();
    renderMemory();
    renderStreams();
    renderMinimap();
  }

  function handleActionStart(payload) {
    if (!payload || typeof payload !== "object") return;

    if (typeof payload.step_details === "string" && payload.step_details.trim()) {
      addLog("status", payload.step_details.trim());
    }

    if (typeof payload.chat_message === "string" && payload.chat_message.trim()) {
      addLog("chat", payload.chat_message.trim(), {
        data: { avatar_emotion: payload.avatar_emotion || null },
      });
    }

    // DAEMONS: the aside is the inner voice and it does NOT belong in the log.
    // The log is a record of what the agent did; this is what it thought while
    // doing it, and mixing them makes both harder to read. Its own panel.
    if (typeof payload.aside === "string" && payload.aside.trim()) {
      pushAside(payload.aside.trim());
    }

    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const parentCallId = String(payload.call_id || "");

    if (actions.length === 0) {
      addLog("action", "Action batch started with no actions.", {
        status: "pending",
        callId: parentCallId,
        data: { action: { type: "unknown" }, message: "Pending..." },
      });
      return;
    }

    actions.forEach((action, index) => {
      addLog("action", "", {
        status: "pending",
        callId: `${parentCallId}_${index}`,
        data: { action, message: "Pending..." },
      });
    });
  }

  function handleActionExecuted(payload) {
    if (!payload || typeof payload !== "object") return;
    const callId = String(payload.call_id || "");
    const log = state.logs.find((entry) => entry.type === "action" && entry.callId === callId);

    if (!log) {
      addLog("action", String(payload.message || ""), {
        status: payload.success ? "completed" : "error",
        callId,
        data: {
          action: { type: payload.action_type || "unknown" },
          success: payload.success,
          message: payload.message || "",
          details: payload.details || "",
        },
      });
      return;
    }

    log.status = payload.success ? "completed" : "error";
    log.data = {
      ...(log.data || {}),
      success: payload.success,
      message: payload.message || "",
      details: payload.details || "",
      action_type: payload.action_type || (log.data?.action?.type ?? "unknown"),
    };
    log.ts = Date.now();
    renderLogs();
  }

  function handleWsMessage(event) {
    state.lastWsAt = Date.now();
    renderRuntime();

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      addLog("error", "Failed to parse WebSocket payload.");
      return;
    }

    const type = message?.type;
    const payload = message?.payload;

    switch (type) {
      case "backchannel":
        if (payload && payload.text) {
          if (!Array.isArray(state.game.backchannel)) state.game.backchannel = [];
          state.game.backchannel.push(payload);
          renderBackchannel();
        }
        return;

      case "dream":
        if (payload && payload.text) {
          if (!Array.isArray(state.game.dreams)) state.game.dreams = [];
          state.game.dreams.push(payload);
          renderDreams();
        }
        return;

      case "full_state":
        mergeFullState(payload);
        return;

      case "objectives_update":
        state.game.objectives = payload || null;
        renderObjectives();
        return;

      case "memory_update":
        state.game.memory = payload && typeof payload === "object" ? payload : {};
        renderMemory();
        return;

      case "markers_update":
        state.game.markers = payload && typeof payload === "object" ? payload : {};
        renderMinimap();
        return;

      case "isThinking_update":
        state.game.isThinking = Boolean(payload);
        renderRuntime();
        return;

      case "isSummaryStep_update":
        state.game.isSummaryStep = Boolean(payload);
        renderRuntime();
        return;

      case "isCriticismStep_update":
        state.game.isCriticismStep = Boolean(payload);
        renderRuntime();
        return;

      case "token_usage_total":
        state.tokenTotals = payload || null;
        if (payload && Number.isFinite(Number(payload.total_tokens))) {
          state.game.total_tokens_accumulated = Number(payload.total_tokens);
        }
        renderRuntime();
        return;

      case "time_usage_total":
        state.timeTotals = payload || null;
        if (payload && typeof payload === "object") {
          state.game.time_usage_totals = {
            reasoning_ms: Number(payload.reasoning_ms || 0),
            tools_ms: Number(payload.tools_ms || 0),
            overall_ms: Number(payload.overall_ms || 0),
            down_ms: Number(payload.down_ms || 0),
          };
        }
        renderRuntime();
        return;

      case "token_usage": {
        const tokens = payload && typeof payload === "object" ? payload : {};
        addLog(
          "status",
          `Token usage: total=${formatNumber(tokens.total_tokens || 0)} input=${formatNumber(
            tokens.input_tokens || 0
          )} output=${formatNumber(tokens.output_tokens || 0)} cost=$${Number(
            tokens.discountedCost || tokens.discounted_cost || 0
          ).toFixed(4)}`
        );
        return;
      }

      case "status_update":
        if (typeof payload === "string") addLog("status", payload);
        return;

      case "error_message":
        addLog("error", typeof payload === "string" ? payload : "Unknown server error.");
        return;

      case "reasoning_chunk":
        queueReasoningChunk(typeof payload === "string" ? payload : String(payload ?? ""));
        return;

      case "reasoning_end":
        closeReasoningStream();
        return;

      case "summary_start":
        state.streams.summaryInProgress = true;
        state.streams.summaryText = "";
        renderStreams();
        addLog("status", "Summary stream started.");
        return;

      case "summary_chunk":
        state.streams.summaryText += typeof payload === "string" ? payload : String(payload ?? "");
        renderStreams();
        return;

      case "summary_end":
        state.streams.summaryInProgress = false;
        if (state.streams.summaryText) state.game.last_summary = state.streams.summaryText;
        renderStreams();
        addLog("status", typeof payload === "string" ? payload : "Summary stream ended.");
        return;

      case "criticism_start":
        state.streams.criticismInProgress = true;
        state.streams.criticismText = "";
        renderStreams();
        addLog("status", "Criticism stream started.");
        return;

      case "criticism_chunk":
        state.streams.criticismText += typeof payload === "string" ? payload : String(payload ?? "");
        renderStreams();
        return;

      case "criticism_end":
        state.streams.criticismInProgress = false;
        if (state.streams.criticismText) state.game.last_criticism = state.streams.criticismText;
        renderStreams();
        addLog("status", typeof payload === "string" ? payload : "Criticism stream ended.");
        return;

      case "action_start":
        handleActionStart(payload);
        return;

      case "action_executed":
        handleActionExecuted(payload);
        return;

      default:
        addLog("status", `Unhandled message type: ${String(type)}`);
    }
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    if (!state.settings.autoReconnect) return;
    state.reconnectTimer = window.setTimeout(() => {
      connectWebSocket();
    }, RECONNECT_DELAY_MS);
  }

  function disconnectWebSocket(manual = false) {
    state.manualDisconnect = manual;
    clearReconnectTimer();

    const ws = state.ws;
    if (!ws) {
      state.isConnected = false;
      renderRuntime();
      return;
    }

    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;

    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, manual ? "Manual disconnect" : "Reconnect");
      }
    } catch {
      // ignore
    }

    state.ws = null;
    state.isConnected = false;
    renderRuntime();
  }

  function connectWebSocket() {
    readSettingsFromInputs();
    disconnectWebSocket(false);
    state.manualDisconnect = false;

    const wsUrl = buildWsUrl();
    addLog("status", `Connecting to ${wsUrl}`);

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      addLog("error", `WebSocket creation failed: ${error.message}`);
      scheduleReconnect();
      return;
    }

    state.ws = ws;

    ws.onopen = () => {
      if (state.ws !== ws) return;
      state.isConnected = true;
      state.lastWsAt = Date.now();
      clearReconnectTimer();
      renderRuntime();
      addLog("status", "WebSocket connected.");
    };

    ws.onmessage = handleWsMessage;

    ws.onerror = () => {
      if (state.ws !== ws) return;
      addLog("error", "WebSocket error.");
    };

    ws.onclose = (event) => {
      if (state.ws !== ws) return;
      state.ws = null;
      state.isConnected = false;
      renderRuntime();
      addLog("status", `WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ""}).`);

      if (!state.manualDisconnect && state.settings.autoReconnect) {
        scheduleReconnect();
      }
    };
  }

  async function pollMinimapOnce() {
    const url = buildMinimapUrl();
    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      if (!body || body.ok !== true || !body.data || !body.data.minimap_data) {
        return;
      }

      const minimap = body.data.minimap_data;
      const mapId = typeof body.data.map_id === "string" ? body.data.map_id : minimap.map_id || null;
      const mapMarkers =
        body.data.map_markers && typeof body.data.map_markers === "object" && !Array.isArray(body.data.map_markers)
          ? body.data.map_markers
          : null;

      if (mapId && mapMarkers) {
        state.minimap.markersByMap[mapId] = mapMarkers;
      }

      if (typeof body.data.visibility_reduced === "boolean") {
        state.game.visibility_reduced = body.data.visibility_reduced;
      }
      if (Number.isFinite(Number(body.data.visibility_window_width_tiles))) {
        state.game.visibility_window_width_tiles = Number(body.data.visibility_window_width_tiles);
      }
      if (Number.isFinite(Number(body.data.visibility_window_height_tiles))) {
        state.game.visibility_window_height_tiles = Number(body.data.visibility_window_height_tiles);
      }

      const nextSeq = Number.isFinite(Number(minimap.seq)) ? Number(minimap.seq) : null;
      const nextMarkersHash = mapMarkers ? JSON.stringify(mapMarkers) : state.minimap.lastMarkersHash;
      const seqChanged = nextSeq === null || nextSeq !== state.minimap.lastSeq;
      const markersChanged = nextMarkersHash !== state.minimap.lastMarkersHash;

      if (!seqChanged && !markersChanged) {
        return;
      }

      state.minimap.data = minimap;
      if (nextSeq !== null) state.minimap.lastSeq = nextSeq;
      state.minimap.lastMarkersHash = nextMarkersHash;
      state.lastPollErrorMessage = "";

      renderMinimap();
      renderRuntime();
    } catch (error) {
      const errMsg = `Minimap polling failed: ${error.message}`;
      if (errMsg !== state.lastPollErrorMessage) {
        state.lastPollErrorMessage = errMsg;
        addLog("error", errMsg);
      }
    }
  }

  function stopMinimapPolling() {
    if (state.pollTimer !== null) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startMinimapPolling() {
    stopMinimapPolling();

    const tick = async () => {
      await pollMinimapOnce();
      state.pollTimer = window.setTimeout(tick, state.settings.pollMs);
    };

    tick();
  }

  function wireControls() {
    els.connectBtn.addEventListener("click", () => {
      readSettingsFromInputs();
      connectWebSocket();
      startMinimapPolling();
      renderRuntime();
    });

    els.disconnectBtn.addEventListener("click", () => {
      disconnectWebSocket(true);
      addLog("status", "Manual disconnect.");
    });

    els.clearLogsBtn.addEventListener("click", () => {
      state.logs = [];
      state.activeReasoningLogId = null;
      state.nextLogId = 1;
      renderLogs();
    });

    els.reconnectInput.addEventListener("change", () => {
      readSettingsFromInputs();
      renderRuntime();
    });
  }

  function bootstrap() {
    setInputDefaults();
    wireControls();
    initTheme();
    initTabs();
    initFrameView();
    wireBackchannel();
    renderAllPanels();
    renderAsides();
    connectWebSocket();
    startMinimapPolling();
    //  Polled rather than pushed. The frame is a file on disk and a turn takes
    //  tens of seconds, so 3s is far more often than it changes and still
    //  costs nothing -- the browser 304s an unchanged image.
    refreshFrame();
    setInterval(refreshFrame, 3000);
  }

  bootstrap();
})();
