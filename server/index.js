require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const fsSync = require("fs");

const { config } = require("./src/config");
const { state, loadPersistentState, attachBroadcast } = require("./src/state/stateManager");
const socketHub = require("./src/core/socketHub");
const { fetchMinimapSnapshot, getMinimapData } = require("./src/services/pythonService");

let gameLoopStarted = false;

const rawBroadcast = socketHub.broadcast;
const loopStepState = { isSummaryStep: false, isCriticismStep: false };
let lastLoopStepBroadcastAtMs = 0;

function computeLoopStepState() {
  const currentStep = state.counters?.currentStep ?? 0;
  const lastCriticismStep = state.counters?.lastCriticismStep ?? 0;
  const lastSummaryStep = state.counters?.lastSummaryStep ?? 0;

  const stepsSinceLastCriticism = currentStep - lastCriticismStep;
  const stepsSinceLastSummary = currentStep - lastSummaryStep;

  const shouldSummarizeBasedOnSteps =
    stepsSinceLastSummary >= config.history.limitAssistantMessagesForSummary;
  const shouldSummarizeBasedOnTokens =
    typeof state.lastTotalTokens === "number" && state.lastTotalTokens >= config.openai.tokenLimit;

  const isSummaryStep = shouldSummarizeBasedOnSteps || shouldSummarizeBasedOnTokens;
  const isCriticismStep =
    !isSummaryStep &&
    stepsSinceLastCriticism >= config.history.limitAssistantMessagesForSelfCriticism;

  return { isSummaryStep, isCriticismStep };
}

function broadcastLoopStepStateUpdate(nextState) {
  rawBroadcast({ type: "isSummaryStep_update", payload: nextState.isSummaryStep });
  rawBroadcast({ type: "isCriticismStep_update", payload: nextState.isCriticismStep });
}

function refreshLoopStepState() {
  const now = Date.now();
  // Avoid double-sending at the start of a loop when multiple "totals" broadcasts happen back-to-back.
  if (now - lastLoopStepBroadcastAtMs < 50) return;
  lastLoopStepBroadcastAtMs = now;

  const nextState = computeLoopStepState();
  loopStepState.isSummaryStep = nextState.isSummaryStep;
  loopStepState.isCriticismStep = nextState.isCriticismStep;
  broadcastLoopStepStateUpdate(nextState);
}

function broadcastWithLoopStepState(message) {
  try {
    if (message?.type === "token_usage_total" || message?.type === "time_usage_total") {
      // Treat these as "beginning of loop" signals.
      refreshLoopStepState();
    }

    if (
      message?.type === "full_state" &&
      message.payload &&
      typeof message.payload === "object" &&
      !Array.isArray(message.payload)
    ) {
      const nextState = computeLoopStepState();
      loopStepState.isSummaryStep = nextState.isSummaryStep;
      loopStepState.isCriticismStep = nextState.isCriticismStep;
      return rawBroadcast({ ...message, payload: { ...message.payload, ...nextState } });
    }
  } catch (error) {
    console.warn("Failed to enrich outbound WS message:", error);
  }

  return rawBroadcast(message);
}

socketHub.broadcast = broadcastWithLoopStepState;

function startGameLoopInBackground() {
  if (gameLoopStarted) return;
  gameLoopStarted = true;

  const run = async () => {
    try {
      const { gameLoop } = require("./src/core/gameLoop");
      await gameLoop();
    } catch (error) {
      console.error("Game loop crashed:", error);
      if (typeof socketHub.broadcast === "function") {
        socketHub.broadcast({
          type: "error_message",
          payload: `Game loop crashed: ${error.message}. Restarting...`,
        });
      }
      gameLoopStarted = false; // Allow a restart attempt
      setTimeout(startGameLoopInBackground, 5000);
    }
  };

  setImmediate(run); // Defer to keep the event loop free for incoming socket handshakes
}

async function start() {
  console.log("Starting Pokémon FireRed agent server...");
  await loadPersistentState();
  state.lastTotalTokens = 0;

  attachBroadcast(socketHub.broadcast);

  const app = express();
  app.use(cors());

  const server = http.createServer(app);
  const wsPort = config.wsPort;

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      wsPort,
      pythonBaseUrl: config.pythonServer.baseUrl,
    });
  });

  //  DAEMONS: speak one line of inner voice.
  //
  //  This proxies rather than letting the page call n8n directly, for two
  //  reasons and the second is the real one. The page would need CORS on the
  //  relay -- annoying. The page would also need `x-dex-secret` IN ITS
  //  JAVASCRIPT, where anyone with the dashboard open can read it. A shared
  //  secret that ships to the browser is not a shared secret. It stays here.
  //
  //  DAEMONS_VOICE_URL points at either tier: the public relay when the
  //  dashboard is being watched from away, the internal workflow when it is
  //  on the same network. Unset means the button reports the feature as off
  //  rather than failing at a connection.
  //  DAEMONS: speak one line of inner voice.
  //
  //  This proxies rather than letting the page call n8n directly, for two
  //  reasons and the second is the real one. The page would need CORS on the
  //  relay -- annoying. The page would also need `x-dex-secret` IN ITS
  //  JAVASCRIPT, where anyone with the dashboard open can read it. A shared
  //  secret that ships to the browser is not a shared secret. It stays here.
  //
  //  TWO TIERS, CHOSEN PER REQUEST. bindDaemons probes once at launch and
  //  pins DAEMONS_VOICE_URL, which is fine until the laptop moves: launched
  //  downstairs on the tailnet, carried upstairs onto another network, and
  //  the pinned tailnet URL stops resolving with no way to notice. A launch
  //  time probe cannot answer a question that changes while the process runs.
  //
  //  So a transport failure here -- DNS, refused, timeout -- retries the
  //  public relay, which needs only an internet connection. An HTTP error
  //  from a reachable backend is NOT retried: that is the voice being broken
  //  rather than unreachable, and trying a second host would only hide it.
  const VOICE_RELAY = process.env.DAEMONS_VOICE_RELAY
    || "https://n8n.codemusic.ca/webhook/daemon/voice";

  //  The other half of the backchannel: what the watcher sends in. Kept on the
  //  server for the same reason /speak is -- the page never needs a secret and
  //  the log survives a refresh.
  app.post("/backchannel", express.json({ limit: "16kb" }), async (req, res) => {
    const bc = require("./src/core/backchannel.js");
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) {
      res.status(400).json({ ok: false, error: "empty" });
      return;
    }
    const entry = bc.tell(state, text, (req.body && req.body.replyTo) || null);
    if (!entry) {
      res.status(400).json({ ok: false, error: "empty" });
      return;
    }
    socketHub.broadcast({ type: "backchannel", payload: entry });
    console.log(`INFO: [backchannel] ${entry.replyTo ? "reply" : "note"}: ${entry.text}`);
    res.json({ ok: true, entry });
  });

  app.post("/speak", express.json({ limit: "64kb" }), async (req, res) => {
    const primary = process.env.DAEMONS_VOICE_URL;
    if (!primary) {
      res.status(503).json({ audioBase64: null, error: "voice_not_configured" });
      return;
    }
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) {
      res.status(400).json({ audioBase64: null, error: "missing_text" });
      return;
    }
    const voice = (req.body && req.body.voice) || process.env.DAEMONS_VOICE || "index";

    //  Returns { payload, status } on a reachable backend, or throws when the
    //  host could not be reached at all -- which is the only case worth a
    //  second attempt elsewhere.
    const attempt = async (url) => {
      //  90s at the TTS server, so give up a little after it does -- a request
      //  that outlives its own backend is a hung play button.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 100000);
      try {
        const upstream = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-dex-secret": process.env.DEX_SHARED_SECRET || "",
          },
          body: JSON.stringify({ text, voice }),
          signal: ctl.signal,
        });
        const payload = await upstream.json().catch(() => null);
        return { payload, status: upstream.status };
      } finally {
        clearTimeout(timer);
      }
    };

    const tiers = primary === VOICE_RELAY ? [primary] : [primary, VOICE_RELAY];
    let lastError = "tts_unreachable";
    for (let i = 0; i < tiers.length; i++) {
      try {
        const { payload, status } = await attempt(tiers[i]);
        if (payload && payload.audioBase64) {
          if (i > 0) console.log(`/speak: ${tiers[0]} was unreachable; the relay answered.`);
          res.json(payload);
          return;
        }
        //  Reachable and unhappy. Report it rather than shopping around.
        res.status(502).json({
          audioBase64: null,
          error: (payload && payload.error) || `tts_http_${status}`,
        });
        return;
      } catch (err) {
        lastError = err?.name === "AbortError" ? "tts_timeout" : "tts_unreachable";
        console.warn(`/speak: ${tiers[i]} failed (${lastError}: ${err?.message || err})`);
      }
    }
    res.status(502).json({ audioBase64: null, error: lastError });
  });

  app.get("/getMinimap", async (req, res) => {
    const minimapData = await getMinimapData();
    res.json(minimapData);
  });

  // Frontend polling endpoint:
  // - Proxies Python `/minimapSnapshot` (cache, non-bloquant pendant /sendCommands)
  // - Adds markers for the current map id
  app.get("/minimapSnapshot", async (req, res) => {
    const minimapData = await fetchMinimapSnapshot();
    if (!minimapData) {
      res.status(502).json({ ok: false, error: "Python minimap snapshot unavailable" });
      return;
    }

    const mapId = typeof minimapData.map_id === "string" ? minimapData.map_id : null;
    const mapMarkers =
      mapId && state.markers && typeof state.markers === "object" ? state.markers[mapId] || {} : {};

    const visibilityReduced = Boolean(minimapData.visibility_reduced);
    const visibilityWindowWidthTiles = Number.isFinite(Number(minimapData.visibility_window_width_tiles))
      ? Number(minimapData.visibility_window_width_tiles)
      : null;
    const visibilityWindowHeightTiles = Number.isFinite(Number(minimapData.visibility_window_height_tiles))
      ? Number(minimapData.visibility_window_height_tiles)
      : null;
    const visibilityHint = typeof minimapData.visibility_hint === "string" ? minimapData.visibility_hint : null;

    res.json({
      ok: true,
      data: {
        minimap_data: minimapData,
        map_id: mapId,
        map_markers: mapMarkers,
        visibility_reduced: visibilityReduced,
        visibility_window_width_tiles: visibilityWindowWidthTiles,
        visibility_window_height_tiles: visibilityWindowHeightTiles,
        visibility_hint: visibilityHint,
      },
    });
  });

  const wss = new socketHub.WebSocket.Server({ server });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(
      `[WS CONNECT] Frontend client connected from ${clientIp}. Current client count: ${
        socketHub.clients.size + 1
      }`
    );
    socketHub.registerClient(ws);

    try {
      const lastSummaryText =
        state.summaries.length > 0 ? state.summaries[state.summaries.length - 1].text : "";
      const lastCriticism = fsSync.existsSync(config.paths.lastCriticismSaveFile)
        ? fsSync.readFileSync(config.paths.lastCriticismSaveFile, "utf8")
        : "";

      const nextLoopStepState = computeLoopStepState();
      loopStepState.isSummaryStep = nextLoopStepState.isSummaryStep;
      loopStepState.isCriticismStep = nextLoopStepState.isCriticismStep;

      const initialState = {
        current_trainer_data: state.gameDataJsonRef?.current_trainer_data || null,
        current_pokemon_data: state.gameDataJsonRef?.current_pokemon_data || [],
        inventory_data: state.gameDataJsonRef?.inventory_data || [],
        objectives: state.objectives,
        map_display: state.gameDataJsonRef?.map_display || null,
        is_talking_to_npc: state.gameDataJsonRef?.is_talking_to_npc || false,
        battle_data: state.gameDataJsonRef?.battle_data || null,
        flash_needed: state.gameDataJsonRef?.flash_needed || false,
        flash_active: state.gameDataJsonRef?.flash_active || false,
        memory: state.memory,
        markers: state.markers,
        progressSteps: state.progressSteps,
        remaining_until_criticism: Math.max(
          0,
          config.history.limitAssistantMessagesForSelfCriticism -
            (state.counters.currentStep - state.counters.lastCriticismStep)
        ),
        remaining_until_summary: Math.max(
          0,
          config.history.limitAssistantMessagesForSummary -
            (state.counters.currentStep - state.counters.lastSummaryStep)
        ),
        steps: state.counters.currentStep,
        last_summary: lastSummaryText,
        last_criticism: lastCriticism,
        //  Why the Criticism panel is empty, said out loud. It has been
        //  blank for days and looked broken every time, because nothing
        //  on screen distinguished "turned off" from "not working".
        self_critique_enabled: config.history.selfCritique,
        //  Both builders, not the one I happened to open first.
        self_model: Array.isArray(state.selfModel) ? state.selfModel : [],
        dreams: Array.isArray(state.dreams) ? state.dreams.slice(-8) : [],
        backchannel: Array.isArray(state.backchannel) ? state.backchannel.slice(-40) : [],
        playtest: Array.isArray(state.playtest) ? state.playtest.slice(-60) : [],
        feelings: state.feelings || null,
        feeling_events: Array.isArray(state.feelingEvents) ? state.feelingEvents : [],
        //  THIS is the full_state a refreshed page receives -- the one sent on
        //  connect, before the loop's next periodic broadcast. Putting asides
        //  only in the loop's copy fixed the case nobody had ("the page has
        //  been open a while") and missed the only case that was asked for
        //  ("I just refreshed"). Two builders of the same message shape, and I
        //  edited the one I happened to find first.
        asides: Array.isArray(state.asides) ? state.asides.slice(-60) : [],
        isSummaryStep: loopStepState.isSummaryStep,
        isCriticismStep: loopStepState.isCriticismStep,
        safari_zone_counter: state.gameDataJsonRef?.safari_zone_counter ?? 0,
        safari_zone_active: state.gameDataJsonRef?.safari_zone_active ?? false,
      };

      ws.send(JSON.stringify({ type: "full_state", payload: initialState }));
      socketHub.broadcast({ type: "status_update", payload: "Frontend connected, initial state sent." });
    } catch (e) {
      console.error("Error sending initial state:", e);
      if (ws.readyState === socketHub.WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error_message", payload: "Failed to send initial state." }));
      }
    }

    ws.on("message", (message) => {
      // Frontend messages are currently ignored (agent runs autonomously).
      // Keep for debugging.
      console.log("Received from client (ignored): %s", message);
    });

    ws.on("close", () => {
      console.log(`[WS CLOSE] Frontend client disconnected. Clients before: ${socketHub.clients.size}`);
      socketHub.unregisterClient(ws);
      console.log(`[WS CLOSE] Client removed. Clients after: ${socketHub.clients.size}`);
    });

    ws.on("error", (error) => {
      console.error(
        `[WS ERROR] WebSocket error on client: ${error.message}. Removing client. Clients before: ${socketHub.clients.size}`
      );
      socketHub.unregisterClient(ws);
      console.error(`[WS ERROR] Client removed due to error. Clients after: ${socketHub.clients.size}`);
    });
  });

  server.listen(wsPort, () => {
    console.log(`HTTP and WebSocket server started on http://localhost:${wsPort}`);
  });

  startGameLoopInBackground();
}

start().catch((error) => {
  console.error("Fatal unhandled error:", error);
  if (typeof socketHub.broadcast === "function") {
    socketHub.broadcast({ type: "error_message", payload: `Fatal error: ${error.message}. Agent stopping.` });
  }
  process.exit(1);
});
