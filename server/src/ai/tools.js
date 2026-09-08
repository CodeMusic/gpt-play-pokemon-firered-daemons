const fs = require('fs').promises;
const fsSync = require('fs');
const { planPath } = require("./localPath.js");

//  DAEMONS: the exact key sequence that just failed to move the player, or
//  null. Advice did not break the loop -- the result already said YOU DID NOT
//  MOVE in capitals and it sent the same keys three turns running -- so the
//  same keys are refused once instead of being sent into the same wall again.
//  Refused ONCE: cleared immediately after, because a blocked tile is not
//  always blocked (an NPC steps aside), and a permanent ban would be a worse
//  bug than the loop.
let lastBlockedKeys = null;
let blockedAtPosition = null;   // where we were when those keys failed
let blockedRefusals = 0;        // consecutive refusals, so we can re-probe
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { config } = require('../config');
const { state, setIsThinking } = require('../state/stateManager');
const { calculateRequestCost } = require('../utils/costs');
const { broadcast } = require('../core/socketHub');
const { sendCommandsToPythonServer, requestConsoleRestart, fetchGameData } = require('../services/pythonService');
const { minimapToMarkdown, formatTilesLegend } = require('../formatters/markdownFormatter');
const { openai } = require('../core/openaiClient');
const { recordPathfindingUsage } = require('../utils/tokenUsageTracker');
const { recordReasoning: recordReasoningTime, recordToolBatch } = require('../utils/timeTracker');

function trunc(text, maxLen = 120) {
    if (text == null) return "";
    const s = String(text);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + "…";
}

function xmlEscape(text) {
    return String(text ?? "");
        // .replaceAll("&", "&amp;")
        // .replaceAll("<", "&lt;")
        // .replaceAll(">", "&gt;")
        // .replaceAll("\"", "&quot;")
        // .replaceAll("'", "&apos;");
}

function xmlAttr(value) {
    return xmlEscape(value).replaceAll("\n", " ").trim();
}

const ALLOWED_KEYPRESS_KEYS = [
    "up",
    "down",
    "left",
    "right",
    "a",
    "b",
    "start",
    "select",
    "a_until_end_of_dialog",
    "face_up",
    "face_down",
    "face_left",
    "face_right",
];

const AVATAR_EMOTIONS = [
    "default",
    "sad",
    "angry",
    "surprised",
    "confused",
    "excited",
    "bored",
    "fierce",
    "cry",
    "happy",
    "scared",
    "disappointed",
    "embarrassed",
    "hurt",
    "thinking",
    "wink",
    "kawai",
    "disgusted",
    "annoyed",
    "confident",
    "nervous",
    "shocked",
    "curious",
    "sleepy",
    "loving",
    "sick",
    "playful",
    "guilty",
    "proud",
    "suspicious",
    "overwhelmed",
    "frustrated",
    "relieved",
    "super_saiyen",
    "nostalgic",
    "smug",
    "tired",
    "mischievous",
    "reading",
    "throwing_pokeball",
    "reading_minimap",
    "cosplay_prof_oak",
    "cosplay_mewtwo",
    "cosplay_pikachu",
    "cosplay_gyarados",
    "cosplay_magikarp",
    "cosplay_missingno",
    "cosplay_zubat",
    "cosplay_blastoise",
    "cosplay_geodude",
    "cosplay_abra",
    "cosplay_pidgeotto",
    "cosplay_pidgeot",
    "cosplay_pidgey",
    "cosplay_team_rocket_member",
    "cosplay_nurse_joy",
    "cosplay_bulbasaur",
    "cosplay_ivysaur",
    "cosplay_venusaur",
    "cosplay_charizard",
    "cosplay_charmeleon",
    "cosplay_charmander",
    "cosplay_snorlax",
    "cosplay_lapras",
];

async function resolveMapBounds(gameDataJson, mapId) {
    if (typeof mapId !== "string" || !mapId.trim()) return null;

    const minimapData = gameDataJson?.minimap_data;
    if (minimapData && minimapData.map_id === mapId) {
        const width = Number(minimapData.width);
        const height = Number(minimapData.height);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return { width, height, source: "minimap_data" };
        }
    }

    // Fallback: fog-of-war minimap cache files live at repo root `minimaps/<map_id>.json`
    const minimapsPath = path.join(config.paths.baseDir, "..", "minimaps", `${mapId}.json`);
    try {
        const raw = await fs.readFile(minimapsPath, "utf8");
        const grid = JSON.parse(raw);
        if (Array.isArray(grid) && grid.length > 0 && Array.isArray(grid[0])) {
            const height = grid.length;
            const width = grid[0].length;
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                return { width, height, source: "minimaps_file" };
            }
        }
    } catch (error) {
        // ignore (missing file or invalid JSON)
    }

    return null;
}

function mapIdFromTraceState(st) {
    const g = st?.map?.group;
    const n = st?.map?.number;
    if (typeof g !== "number" || typeof n !== "number") return null;
    return `${g}-${n}`;
}

function mapKeyFromTraceState(st) {
    const mapId = mapIdFromTraceState(st);
    const mapName = st?.map?.name;
    if (!mapId && !mapName) return null;
    return `${mapId || ""}|${mapName || ""}`;
}

function formatMapLabel(mapId, mapName) {
    const id = typeof mapId === "string" ? mapId.trim() : "";
    const name = typeof mapName === "string" ? mapName.trim() : "";
    if (id && name) return `${id} — ${name}`;
    return id || name || "unknown";
}

function traceStateMarkdownLines(st, { includeMap = true } = {}) {
    const lines = [];

    const mapId = mapIdFromTraceState(st);
    const mapName = st?.map?.name;
    if (includeMap && (mapId || mapName)) {
        if (mapId && mapName) lines.push(`- Map: ${mapId} — ${mapName}`);
        else if (mapId) lines.push(`- Map: ${mapId}`);
        else lines.push(`- Map: ${mapName}`);
    }

    const pos = st?.player?.position;
    const x = Array.isArray(pos) && pos.length > 0 ? pos[0] : null;
    const y = Array.isArray(pos) && pos.length > 1 ? pos[1] : null;
    const facing = st?.player?.facing;
    const elevation = st?.player?.elevation;
    if (x != null && y != null) {
        const extras = [];
        if (facing) extras.push(`facing ${facing}`);
        if (typeof elevation === "number" && Number.isFinite(elevation)) extras.push(`elevation ${elevation}`);
        const extraText = extras.length ? `, ${extras.join(", ")}` : "";
        lines.push(`- Position: (${x},${y})${extraText}`);
    }

    const inDialog = !!st?.dialog?.inDialog;
    if (inDialog) {
        const menuType = st?.dialog?.menuType || "dialog";
        const text = st?.dialog?.visibleText;
        lines.push(`- Dialog (${menuType}): ${String(text ?? "")}`);
    }

    return lines;
}

function cmdLabelFromStep(step) {
    const t = step?.type ?? "?";
    const c = step?.command || {};
    if (t === "control") return String(c.command || "");
    if (t === "hold") return `hold:${c.button || "?"}:${c.frames || "?"}`;
    if (t === "press") return `press:${(c.buttons || []).join("+")}`;
    if (t === "controlStatus") return "controlStatus";
    return t;
}

function remainingCommandsFromPayload(payload) {
    const rem = Array.isArray(payload?.remaining_keys) ? payload.remaining_keys : [];
    return rem.map((c) => {
        if (c?.type === "control") return c.command;
        if (c?.type === "hold") return `hold:${c.button || "?"}:${c.frames || "?"}`;
        if (c?.type === "press") return `press:${(c.buttons || []).join("+")}`;
        return c?.type || "?";
    });
}

function summarizeTracePayloadMarkdown(payload) {
    if (!payload) {
        return "No payload";
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    const remaining = remainingCommandsFromPayload(payload);
    const interrupted = payload.interruptedByDialog === true;
    const interruptedByCollision = payload.interruptedByCollision === true;
    const collisionStreak = typeof payload.collisionStreak === "number" ? payload.collisionStreak : null;
    const startedInDialog = payload.startedInDialog === true;
    const interruptedAtIndex = typeof payload.interruptedAtIndex === "number" ? payload.interruptedAtIndex : null;
    const ok = payload.ok === true;
    const status = payload.status === true;

    const lines = [];
    lines.push(`Run:`);
    lines.push(`- ok: ${ok ? "true" : "false"}`);
    lines.push(`- status: ${status ? "true" : "false"}`);
    lines.push(`- startedInDialog: ${startedInDialog ? "true" : "false"}`);
    lines.push(`- interruptedByDialog: ${interrupted ? "true" : "false"}`);
    if (interruptedAtIndex != null) {
        lines.push(`- interruptedAtIndex: ${interruptedAtIndex}`);
    }
    lines.push(`- interruptedByCollision: ${interruptedByCollision ? "true" : "false"}`);
    if (collisionStreak != null) {
        lines.push(`- collisionStreak: ${collisionStreak}`);
    }

    const notes = [];
    if (interrupted) {
        notes.push("Dialog detected while executing commands, stopping sequence");
    }
    if (interruptedByCollision) {
        notes.push(
            `WARNING: Command sequence interrupted due to ${collisionStreak != null ? collisionStreak : 5} collisions in a row`
        );
    }

    if (remaining.length) {
        lines.push(`- remainingCommands: ${JSON.stringify(remaining)}`);
    }

    if (notes.length) {
        lines.push("");
        lines.push("Notes:");
        for (const note of notes) {
            lines.push(`- ${note}`);
        }
    }

    let lastMapKey = null;
    for (let i = 0; i < results.length; i++) {
        const step = results[i];
        const stepIndex = i + 1;
        const btn = cmdLabelFromStep(step);
        const okAttrVal = step?.ok === true ? "true" : "false";
        const msAttrVal = typeof step?.ms === "number" ? String(step.ms) : "";
        const typeAttrVal = step?.type ?? "?";

        lines.push("");
        lines.push(
            `### Step ${stepIndex} — ${btn}${typeAttrVal || okAttrVal || msAttrVal ? ` (type=${typeAttrVal}, ok=${okAttrVal}${msAttrVal ? `, ms=${msAttrVal}` : ""})` : ""}`
        );

        const beforeState = step?.before || {};
        const afterState = step?.after || {};
        const beforeMapKey = mapKeyFromTraceState(beforeState);
        const afterMapKey = mapKeyFromTraceState(afterState);
        const includeMapBefore = beforeMapKey != null && (lastMapKey == null || beforeMapKey !== lastMapKey);
        const includeMapAfter = afterMapKey != null && afterMapKey !== beforeMapKey;

        lines.push("");
        lines.push("Before:");
        const beforeLines = traceStateMarkdownLines(beforeState, { includeMap: includeMapBefore });
        lines.push(...(beforeLines.length ? beforeLines : ["- (no data)"]));

        lines.push("");
        lines.push("After:");
        const afterLines = traceStateMarkdownLines(afterState, { includeMap: includeMapAfter });
        lines.push(...(afterLines.length ? afterLines : ["- (no data)"]));

        // Custom trace payloads (ex: a_until_end_of_dialog transcript)
        const trace = step?.trace;
        const transcript = Array.isArray(trace?.transcript) ? trace.transcript : [];
        const evts = Array.isArray(trace?.events) ? trace.events : [];
        const stopReason = trace?.stopReason;
        const presses = typeof trace?.pressCount === "number" ? trace.pressCount : null;
        const autoPresses = typeof trace?.autoPressCount === "number" ? trace.autoPressCount : null;
        const dur = typeof trace?.durationMs === "number" ? trace.durationMs : null;
        const timedOut = trace?.timedOut === true;
        const maxPressesHit = trace?.maxPressesHit === true;

        if (stopReason || presses != null || autoPresses != null || dur != null || timedOut || maxPressesHit) {
            lines.push("");
            lines.push("Trace:");
            if (stopReason) lines.push(`- stopReason: ${String(stopReason)}`);
            if (presses != null) lines.push(`- pressCount: ${presses}`);
            if (autoPresses != null) lines.push(`- autoPressCount: ${autoPresses}`);
            if (dur != null) lines.push(`- durationMs: ${dur}`);
            if (timedOut) lines.push(`- timedOut: true`);
            if (maxPressesHit) lines.push(`- maxPressesHit: true`);
        }

        const groundWallChanged = trace?.groundWallChanged;
        const rawWallsToFree = Array.isArray(groundWallChanged?.wallsToFree) ? groundWallChanged.wallsToFree : [];
        const wallsToFree = rawWallsToFree
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        const rawFreeToWalls = Array.isArray(groundWallChanged?.freeToWalls) ? groundWallChanged.freeToWalls : [];
        const freeToWalls = rawFreeToWalls
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        const stepEvents = evts
            .map((e) => (e == null ? "" : String(e)))
            .map((e) => e.trim())
            .filter(Boolean);
        const mapUpdates = [];

        if (wallsToFree.length || freeToWalls.length) {
            const mapId =
                (typeof groundWallChanged?.mapId === "string" && groundWallChanged.mapId.trim())
                    ? groundWallChanged.mapId.trim()
                    : (mapIdFromTraceState(step?.after || {}) || mapIdFromTraceState(step?.before || {}));
            const mapName =
                (typeof groundWallChanged?.mapName === "string" && groundWallChanged.mapName.trim())
                    ? groundWallChanged.mapName.trim()
                    : (step?.after?.map?.name || step?.before?.map?.name);
            const mapIdText = mapId || "unknown";
            stepEvents.push(`Free Ground/Collision tiles changed on map ${mapIdText}`);
            if (wallsToFree.length) {
                const posAttr = wallsToFree.map(([x, y]) => `${x},${y}`).join("|");
                mapUpdates.push(
                    `- collision_to_free (${formatMapLabel(mapId, mapName)}): ${posAttr}`
                );
            }
            if (freeToWalls.length) {
                const posAttr = freeToWalls.map(([x, y]) => `${x},${y}`).join("|");
                mapUpdates.push(
                    `- free_to_collision (${formatMapLabel(mapId, mapName)}): ${posAttr}`
                );
            }
        }

        const tilesDiscovered = trace?.tilesDiscovered;
        const rawPositions = Array.isArray(tilesDiscovered?.positions) ? tilesDiscovered.positions : [];
        const positions = rawPositions
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        if (positions.length) {
            const mapId =
                (typeof tilesDiscovered?.mapId === "string" && tilesDiscovered.mapId.trim())
                    ? tilesDiscovered.mapId.trim()
                    : (mapIdFromTraceState(step?.after || {}) || mapIdFromTraceState(step?.before || {}));
            const mapName =
                (typeof tilesDiscovered?.mapName === "string" && tilesDiscovered.mapName.trim())
                    ? tilesDiscovered.mapName.trim()
                    : (step?.after?.map?.name || step?.before?.map?.name);
            const posAttr = positions.map(([x, y]) => `${x},${y}`).join("|");
            const msg =
                'You discovered new tiles on the minimap after executing your commands, some "?" are now visible.';
            stepEvents.push(msg);
            mapUpdates.push(
                `- tiles_discovered (${formatMapLabel(mapId, mapName)}): ${posAttr}`
            );
        }

        if (transcript.length) {
            lines.push("");
            lines.push("Transcript:");
            for (const t of transcript) {
                if (t == null) continue;
                lines.push(`- ${String(t)}`);
            }
        }

        if (stepEvents.length) {
            lines.push("");
            lines.push("Events:");
            for (const e of stepEvents) {
                lines.push(`- ${e}`);
            }
        }

        if (mapUpdates.length) {
            lines.push("");
            lines.push("Map updates:");
            lines.push(...mapUpdates);
        }

        if (step?.wait) {
            const w = step.wait;
            const okW = w?.ok ? "true" : "false";
            const toW = w?.timedOut ? "true" : "false";
            const activeW = w?.parsed?.active ?? "";
            const queueW = w?.parsed?.queue ?? "";
            lines.push("");
            lines.push("Wait:");
            lines.push(`- ok: ${okW}`);
            lines.push(`- timedOut: ${toW}`);
            if (activeW) lines.push(`- active: ${activeW}`);
            if (queueW) lines.push(`- queue: ${queueW}`);
        }

        if (step?.error) {
            lines.push("");
            lines.push("Error:");
            lines.push(String(step.error));
        }

        const newLastMapKey = mapKeyFromTraceState(afterState) || mapKeyFromTraceState(beforeState);
        if (newLastMapKey != null) lastMapKey = newLastMapKey;
    }

    return lines.join("\n").trim();
}

function defineTools() {
    // Individual schemas for each action type.
    const keyPressActionSchema = z.object({
        //  DAEMONS: say "several", because the cost of a turn is the PROMPT.
        //  A turn spends ~193s re-reading 35k tokens and ~0.3s writing 60
        //  tokens, so one key per turn is 3.5 minutes to move one tile. The
        //  keys are a list; filling it costs nothing.
        type: z.literal("key_press").describe(
            "Press one or SEVERAL keys in sequence. Send the whole run at once -- "
            + "['up','up','up','left'] costs exactly as much as ['up'] and covers "
            + "four tiles instead of one. Sending a single key when you know the "
            + "next few wastes an entire turn."),
        keys: z.array(z.enum(ALLOWED_KEYPRESS_KEYS)).describe("Keys to send (e.g., 'up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'). Use 'face_up', 'face_down', 'face_left', 'face_right' to change the orientation of the player without moving.")
    });

    const addMarkerActionSchema = z.object({
        type: z.literal("add_marker").describe("Action to create a custom marker on the minimap."),
        map_name: z.string().describe("Name of the map where to place the marker."),
        map_id: z.string().describe("ID of the map where to place the marker."),
        x: z.number().describe("X coordinate of the marker."),
        y: z.number().describe("Y coordinate of the marker."),
        emoji: z.string().describe("Emoji representing the marker. Choose a relevant emoji for the type of place."),
        label: z.string().describe("Detailed description of the marker. Make it as long as needed to be informative, do not be concise when it's needed."),
    });

    const writeMemoryActionSchema = z.object({
        type: z.literal("write_memory").describe("Action to write / update state.memory."),
        key: z.string().describe("Key for the information to memorize. Use prefixes to organize (e.g., 'location_', 'quest_', 'item_', 'tips_')."),
        value: z.string().describe("Value to memorize. Be precise and concise. Do not use for trivial information."),
    });

    const deleteMemoryActionSchema = z.object({
        type: z.literal("delete_memory").describe("Action to delete from state.memory."),
        key: z.string().describe("Key for the information to delete."),
    });

    //  DAEMONS: reflect when an objective is REACHED, not on a timer.
    //
    //  Two problems, one answer. The model's own reasoning and messages were
    //  54.8% of an 882k-char prompt, and 105 reasoning blocks were replayed
    //  every turn -- so the history has to be dropped. But dropping it loses
    //  whatever was learned getting here, which is the only part worth keeping.
    //
    //  So: summarise the span, keep the lesson, drop the span. Compression that
    //  preserves the finding instead of the transcript.
    const reflectActionSchema = z.object({
        type: z.literal("reflect").describe(
            "Call this the moment you COMPLETE an objective, before setting the next one. "
            + "Look back over everything since the last objective and write down what you "
            + "LEARNED -- not what happened. The turn-by-turn history is discarded; this "
            + "sentence is what survives it."),
        learned: z.string().describe(
            "One or two sentences, in the form of a rule you could follow again. "
            + "'Exit carpets fire on a blocked move, not on stepping onto them' is useful. "
            + "'I went downstairs' is not -- that is what happened, not what you learned."),
        worked: z.string().describe("The one thing that worked. Be specific about WHY it worked."),
        wasted: z.string().describe(
            "The one thing that wasted turns. If nothing did, say so plainly rather than "
            + "inventing a fault."),
        //  The self-model, and the reason it exists.
        //
        //  `learned` is about the GAME -- exit carpets, ledges, menu order.
        //  This is about the PLAYER. Without it the inner voice has no speaker:
        //  every aside is generated fresh with nothing to be consistent with,
        //  so it drifts to whatever register the field description last nudged
        //  it toward. Three rewrites of that description produced three
        //  different degenerate voices -- fragments, then "I am..." on every
        //  line, then terse procedural notes -- because the problem was never
        //  the wording.
        about_self: z.string().describe(
            "ONE SENTENCE about yourself, not about the game: what this stretch showed "
            + "you about how YOU play. A tendency, a habit, something you keep doing, a "
            + "way you tend to react. First person. "
            + "\n\nGood: \"I commit to a route before I have checked it, and then I am "
            + "reluctant to turn back.\" / \"I get impatient in menus and start mashing.\" "
            + "/ \"I am more careful after a faint than before one.\" "
            + "\n\nWrong: \"I explored the town\" -- that is what happened. \"Exit carpets "
            + "need a blocked move\" -- that is the `learned` field. This one is about "
            + "your own character as a player, and it is what your inner voice speaks "
            + "from. Be honest rather than flattering; a fault named plainly is worth "
            + "more than a virtue claimed."),
    });

    const updateObjectivesActionSchema = z.object({
        type: z.literal("update_objectives").describe("Action to update the current game state.objectives."),
        primary: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The main objective. Use both short_description and description. Do not leave empty."),
        secondary: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The secondary objective. Use both short_description and description. Do not leave empty."),
        third: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The third objective. Use both short_description and description. Do not leave empty."),
        others: z.array(z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        })).describe("List of other state.objectives. Each must have a short_description and description. Do not leave empty."),
    });

    // Schema for deleting a marker
    const deleteMarkerActionSchema = z.object({
        type: z.literal("delete_marker").describe("Action to delete a custom marker from the map."),
        map_id: z.string().describe("ID of the map where the marker is located."),
        x: z.number().describe("X coordinate of the marker to delete."),
        y: z.number().describe("Y coordinate of the marker to delete."),
    });

    // Pathfinding schema
    const pathfindingActionSchema = z.object({
        //  DAEMONS: the 20-tile threshold was written when this ran on OpenAI's
        //  Code Interpreter -- a model writing Python, uploaded to a container,
        //  executed remotely. Rationing it made sense. It is now a breadth-first
        //  search over the collision grid already in memory: exact, instant,
        //  free, and it cannot route through a wall. The advice is now backwards,
        //  and the run it produced was one tile per 3.5-minute turn.
        type: z.literal("path_to_location").describe(
            "Walk to a tile on this map. PREFER THIS over key_press for any move "
            + "of more than a step or two: it is instant, it costs no more than a "
            + "single key press, and it routes around walls and furniture for you. "
            + "Give it the destination and it does the whole journey in one turn -- "
            + "the stairs, a door, the far side of the room."),
        x: z.number().describe("X coordinate of the destination."),
        y: z.number().describe("Y coordinate of the destination."),
        map_id: z.string().describe("ID of the map where the destination is located."),
        explanation: z.string().describe(
            "Brief description of the movement plan including: " +
            "• Starting point and destination " +
            "• Purpose of the movement " +
            "• Any navigation preferences or conditions (e.g., 'Avoid tall grass if possible', 'Take shortest route to gym entrance')"
        ),
    });

    // Restart console schema
    const restartConsoleActionSchema = z.object({
        type: z.literal("restart_console").describe("Action to reboot the Game Boy console back to the title screen. BE SURE TO HAVE SAVED THE GAME BEFORE USING THIS TOOL."),
    });

    // Union of possible action schemas.
    //
    // DAEMONS_SCHEMA=lean drops three variants. It is NOT a speed measure,
    // and the first version of this comment said it was.
    //
    // MEASURED, warmed and alternating so neither owned the cold call:
    //     lean(5)  median 3.7s     full(8)  median 3.8s
    // No difference. The 9.3s and 11.4s that motivated the trim were cold
    // starts -- LM Studio reported the model as not-loaded, so the first call
    // of a batch paid a model load and every ordering I ran gave the second
    // variant an unearned win. The schema was never the bottleneck.
    //
    // What lean is still for: three fewer branches for a small model to
    // disambiguate, which is the failure that produced "Executing Action 1/2:
    // undefined". That is a CORRECTNESS argument and it is untested. The three
    // dropped only annotate -- add_marker and delete_marker decorate the
    // dashboard's minimap, restart_console is an escape hatch that should
    // almost never fire -- so lean costs nothing that plays the game.
    //
    // FULL is the default now, and the reason is the word "only" above. The
    // markers cost the AGENT nothing and they are most of what a watching
    // human gets: without them the map is a grid of tiles with no doors and
    // no stairs marked on it. "Costs nothing that plays the game" was true
    // and still missed that somebody is also reading.
    //
    // update_objectives stays despite being 35% of the schema: it is how the
    // agent carries a plan across the summarisation fold.
    //
    // DAEMONS_SCHEMA=lean drops back to five.
    const leanSchema = (process.env.DAEMONS_SCHEMA || "full") !== "full";
    const actionVariants = [
        keyPressActionSchema,
        writeMemoryActionSchema,
        deleteMemoryActionSchema,
        updateObjectivesActionSchema,
        pathfindingActionSchema,
        //  In the LEAN set deliberately. Reflection is not a luxury for a big
        //  model -- it is how a small one stops re-learning the same thing,
        //  and how the history gets short enough for either to read.
        reflectActionSchema,
    ];
    if (!leanSchema) {
        actionVariants.push(
            addMarkerActionSchema,
            deleteMarkerActionSchema,
            restartConsoleActionSchema,
        );
    }
    console.log(`Action schema: ${leanSchema ? "lean" : "full"} (${actionVariants.length} variants)`);
    const actionUnionSchema = z.union(actionVariants);

    // Main schema for the execute_action tool
    const executeActionSchema = z.object({
        step_details: z.string().describe("An explanation of what happened in the previous step and what the next step is. Include all necessary details."),
        actions: actionUnionSchema.array().describe("One or multiple action(s) to execute"),
        chat_message: z.string().describe("A narrative comment describing your intent, reaction, or what happened during this step."),
        avatar_emotion: z.enum(AVATAR_EMOTIONS).describe("Select the avatar emotion that best matches your current mood, reaction, or activity. Choose from basic emotions (happy, sad, angry, etc.), specific reactions (surprised, confused, thinking, etc.), action-based emotions (reading, throwing_pokeball, etc.), or themed cosplay options when appropriate for the context."),
    });

    // DAEMONS: TOOL SHAPE IS PER-MODEL, AND NESTED IS THE DEFAULT.
    //
    // Measured, streaming, same prompt:
    //                     nested                    flat
    //   minicpm-v-4.6     completed, 1 call         FAILED, 0 calls
    //   qwen3-vl-8b       completed, 27 duplicates  completed, 1 call
    //
    // AND THE MINICPM ROW IS NOT A SCHEMA PROBLEM AT ALL. LM Studio:
    //     Prediction failed: Failed to parse tool call:
    //     Expected "<parameter=", but got "<keys=['A'," at index 33
    // MiniCPM emits tool calls in its own XML dialect and LM Studio's parser
    // expects another. It needs SGLang's --tool-call-parser minicpm5 or vLLM's
    // parser plugin, neither of which is LM Studio -- so minicpm cannot make a
    // tool call here whatever shape we ask for, and its "invalid tool name"
    // warning is the downstream symptom of that parse failure rather than a
    // complaint about the name. I read that symptom as a diagnosis twice.
    //
    // So flat is the default: it is the shape that works for the model that
    // works. DAEMONS_TOOLS=nested is upstream's, kept for a serving layer that
    // can parse minicpm properly.
    //
    // With one execute_action wrapping a union, LM Studio logged
    //     Failed generating function tool request 'key_press' due to an
    //     invalid tool name. Skipping function_call output item.
    // -- minicpm-v-4.6 was calling key_press directly, because key_press is
    // the thing it wants to do; the wrapper is our idea, not the model's. And
    // qwen3-vl-8b mangled the same union in its own way, emitting the
    // identical call 27 times in one response. Two models, two symptoms, one
    // cause: a nested discriminated union is hard to emit and easy to flatten.
    //
    // So each action becomes its own tool, which is the shape they reach for
    // unprompted. handleToolCall normalises a flat call back into the
    // execute_action envelope, so every dispatch path below is unchanged.
    //
    // DAEMONS_TOOLS=nested restores the single wrapper.
    const flat = (process.env.DAEMONS_TOOLS || "flat") !== "nested";
    if (!flat) {
        console.log("Tool shape: nested (1 tool, union of " + actionVariants.length + ")");
        return [
            {
                type: "function",
                name: "execute_action",
                description: "Executes an action in the game: movement, interaction, or memorizing information. Adapt the action to the context (dialogue or free movement).",
                parameters: zodToJsonSchema(executeActionSchema),
                strict: config.tools.strict,
            },
        ];
    }

    const NARRATION = {
        step_details: z.string().describe("What happened in the previous step and what this step does."),
        chat_message: z.string().describe("A short narrative comment on your intent."),
        //  DAEMONS: the inner voice, and it is NOT another planning field.
        //
        //  step_details and chat_message both answer "what am I doing" -- the
        //  run reads as a machine narrating its own dispatch log. This one
        //  answers "what do I make of this", which is a different question and
        //  produces a different register.
        //
        //  Kept deliberately cheap: one or two sentences. The point is not
        //  volume, and every token here is a token of prompt on the next turn.
        //  Battle is where it earns its place -- something is standing in front
        //  of it and it has an opinion about that.
        //
        //  It is also, unavoidably, the thing this project is about. A daemon
        //  is read by what it does unasked (4.29). An agent that reports what
        //  it privately thinks while it plays is that argument running rather
        //  than being made.
        //  The first version asked for "one or two sentences" and got
        //  "Attacking", "Need heal", "Pick attack" -- telegraphic fragments,
        //  which is a log line wearing an inner voice. It also produced "Faint
        //  hurts", which is exactly the register wanted and still not a
        //  sentence. So the rule is now explicit: a COMPLETE SENTENCE, and it
        //  must contain "I". Showing the failure alongside the fix is what
        //  makes the difference legible to a model.
        //  THIRD VERSION OF THIS FIELD, and each rewrite was caused by reading
        //  the output rather than by thinking harder about the wording.
        //
        //  v1 asked for "one or two sentences, first person" and got
        //  "Attacking", "Need heal", "Pick attack" -- log lines wearing an
        //  inner voice.
        //
        //  v2 fixed that with "must contain the word I", and got EVERY LINE
        //  STARTING WITH IT: "I am annoyed by...", "I am hopeful that...",
        //  "I am curious what...", eleven in a row. The rule was a proxy for
        //  first person and the model satisfied the proxy the cheapest way
        //  available -- put the token at the front, every time. A voice that
        //  never varies its opening is a template, not a voice.
        //
        //  v3 describes the STANCE instead of mandating a token: a thought
        //  nobody else can hear. Where "I" lands, or whether it appears at
        //  all, is left alone -- "That was closer than it should have been"
        //  is first person without the word in it.
        aside: z.string().describe(
            "One or two COMPLETE SENTENCES of inner thought, present tense: what you "
            + "are actually thinking, as though nobody can hear it. "
            + "\n\nSPEAK AS THE PERSON DESCRIBED IN <self>. Those observations are your "
            + "own, about how you play, and this is the voice they belong to. If <self> "
            + "is empty you have not reflected yet -- write as yourself anyway, and it "
            + "will fill in. <dream> may have left a mood on you; let it colour how this "
            + "lands, but never quote it and never mention it. "
            + "\n\n<feelings> IS HOW YOU ACTUALLY FEEL RIGHT NOW, and it is not a "
            + "suggestion -- it was measured from what has been happening to you. If it "
            + "says you are AFRAID, the thought should sound like someone afraid. If it "
            + "says you are level, do not manufacture a mood. NEVER NAME THOSE WORDS. "
            + "Write what a person in that state would think about what is in front of "
            + "them; the feeling shows in what you notice and how you put it, not in a "
            + "label. "
            + "\n\nIN A BATTLE, SAY WHAT YOU FEEL and not only what you reckon. Battles "
            + "are the moments with something at stake, and \"this one looks slow\" is a "
            + "read where \"I do not want to lose this one\" is a thought. Nerve, relief, "
            + "irritation, respect for the thing across from you, wanting it over -- those "
            + "belong here. So does a flat line when you genuinely feel nothing, but not "
            + "every turn. "
            + "\n\nIT MUST BE A THOUGHT, NOT A NOTE TO YOURSELF. \"Menu first, then "
            + "options.\" and \"Three downs should land on OPTION.\" and \"Menu done, back "
            + "to lab.\" are all WRONG -- they are procedure, clipped down to a label. "
            + "Nobody's interior monologue sounds like a checklist. If what you are about "
            + "to write would fit on a sticky note, it belongs in step_details instead. "
            + "\n\nDO NOT START EVERY ONE WITH \"I\". That is the most common failure "
            + "here and it turns this into a template. A run that reads \"I am annoyed "
            + "by...\", \"I am hopeful that...\", \"I am curious what...\" line after line "
            + "is wrong even though every sentence is fine on its own. VARY THE OPENING. "
            + "The word \"I\" does not have to appear at all -- \"That was closer than it "
            + "should have been\" is a thought from inside your own head without it. "
            + "\n\nGood, and note how differently they open: \"This one looks fierce; "
            + "better to be careful.\" / \"That was a close encounter.\" / \"Something "
            + "about this room is wrong.\" / \"Still no sign of the way north.\" / \"He "
            + "said that like it mattered.\" / \"I do not like the look of this one.\" "
            + "\n\nWrong: \"Attacking\" or \"Need heal\" -- fragments, not thoughts. Also "
            + "wrong: anything in second or third person. This is not narration and not "
            + "a status line; it is the voice in your own head. "
            + "\n\nIt should be possible to tell WHO IS SPEAKING from how it is written. "
            + "Two different players in the same spot would think different things about "
            + "it -- write the one that is yours. "
            + "\n\nIt is not a plan and not a summary -- you have other fields for both. "
            + "What do you MAKE of what is in front of you? In a battle: the daemon "
            + "opposite, your own, how this is going. In the world: this place, this "
            + "person, this line of dialogue. Write it the way a thought arrives, not "
            + "the way a report is filed."),
    };
    const tools = actionVariants.map((variant) => {
        //  the literal `type` becomes the tool NAME, so it is dropped from the
        //  parameters -- a model that has to restate its own tool name in the
        //  arguments is being asked the same question twice.
        const name = variant.shape.type._def.value;
        const body = variant.omit({ type: true }).extend(NARRATION);
        return {
            type: "function",
            name,
            description: variant.shape.type._def.description
                || ("Perform the " + name + " action."),
            parameters: zodToJsonSchema(body),
            strict: config.tools.strict,
        };
    });
    console.log("Tool shape: flat (" + tools.length + " tools: "
        + tools.map((t) => t.name).join(", ") + ")");
    return tools;
}

/**
 * Handles the call of a specific tool requested by the AI.
 * @param {object} toolCall - The toolCall object from the OpenAI response.
 * @param {object} gameDataJson - The current game data
 * @returns {Promise<object>} The result of the function call for the history.
 */
async function handleToolCall(toolCall, gameDataJson) {
    let { name, arguments: argsString, call_id } = toolCall;

    //  DAEMONS: a flat tool call is an execute_action with one action in it.
    //  Rewriting it here means every dispatch path below stays exactly as it
    //  was, and a run can switch shapes without two code paths to keep honest.
    if (name !== "execute_action") {
        try {
            const a = JSON.parse(argsString || "{}");
            //  `aside` has to be lifted with the other two. It is NARRATION on
            //  the envelope, not a parameter of the action -- leave it in
            //  `rest` and it ends up inside actions[0], where nothing reads it.
            //
            //  That is why the Inner voice panel stayed empty through 84 tool
            //  calls: the model WAS emitting it (the schema requires it), the
            //  broadcast carried args.aside, and args.aside was undefined
            //  because this line had put it somewhere else. Every end wired,
            //  one silent hop in the middle.
            const { step_details, chat_message, aside, ...rest } = a;
            argsString = JSON.stringify({
                step_details: step_details || ("Performing " + name + "."),
                chat_message: chat_message || "",
                aside: aside || "",
                actions: [{ type: name, ...rest }],
            });
            name = "execute_action";
        } catch (e) {
            /* fall through to the unknown-tool path below, which reports it */
        }
    }
    const toolBatchStart = Date.now();
    let allActionResults = [];
    let overallSuccess = true;
    let keyPressExecutedThisTurn = false;
    let pathfindingExecutedThisTurn = false;

// DAEMONS: a function_call_output's `output` must be a STRING for LiteLLM's
// /responses -> /chat/completions bridge. api.openai.com accepts either;
// the bridge rejects the array form with a flat
//     400 Invalid type for 'input'   (code: invalid_union)
// that names `input` and never points at the tool result inside it.
//
// Every construction site here builds a single input_text item, so the string
// form is lossless. Images only ever entered these via the append path in
// gameLoop.js, which is off by default for the same reason -- and with it off,
// historyProcessor's Array.isArray(output) test correctly stops treating tool
// results as data messages, because they no longer carry any.
//
// DAEMONS_EXTEND_TOOL_OUTPUT=1 restores the array form.
function toolOutput(text) {
    return process.env.DAEMONS_EXTEND_TOOL_OUTPUT === "1"
        ? [{ type: "input_text", text }]
        : String(text);
}


    if (name !== "execute_action") {
        console.error(`Error: Received unexpected tool call '${name}'.`);
        state.skipNextUserMessage = true;
        return {
            type: "function_call_output",
            call_id: call_id,
            output: toolOutput(`Error: Unexpected tool name '${name}'. Expected 'execute_action'.`),
        };
    }

    let args;
    try {
        args = JSON.parse(argsString);
        console.log(`---> Tool Call Start: ${name} (ID: ${call_id})`);
        console.log(`Step Details: ${args.step_details}`);
        console.log(`Chat Message: ${args.chat_message}`);
        //  Greppable on its own, because the inner voice is the one line of a
        //  run somebody might actually want to read back afterwards.
        if (args.aside) console.log(`Aside: ${args.aside}`);
        console.log(`Avatar Emotion: ${args.avatar_emotion}`);

        if (!args.actions || !Array.isArray(args.actions)) {
            throw new Error("'actions' argument is missing or is not an array.");
        }
        if (args.actions.length === 0) {
            console.error("ERROR: Tool call received with no actions to execute, it's forbidden to send an empty action.");
            state.skipNextUserMessage = true;
            console.log("Setting state.skipNextUserMessage = true due to empty action tool call.");
            return {
                type: "function_call_output",
                call_id: call_id,
                output: toolOutput("ERROR: Tool call received with no actions to execute, it's forbidden to send an empty action."),
            };
        }

        const restartConsolePresent = args.actions.some((action) => action.type === "restart_console");
        if (restartConsolePresent && args.actions.length > 1) {
            const errorText = "Error: 'restart_console' must be the ONLY action in the list. Remove all other actions and try again. (And be sure to have saved the game before using this tool.)";
            console.error(errorText);
            return {
                type: "function_call_output",
                call_id: call_id,
                output: toolOutput(errorText),
            };
        }

        const batchActionStartPayload = {
            call_id: call_id,
            step_details: args.step_details,
            chat_message: args.chat_message,
            //  The inner voice was in the schema, in the log, and read by the
            //  dashboard -- and never put in this payload, so the panel could
            //  not have shown anything whatever the model wrote. Three of the
            //  four ends wired, which is the shape of bug that looks like a
            //  model problem.
            aside: args.aside,
            avatar_emotion: args.avatar_emotion,
            actions: args.actions,
        };
        //  Keep it, not just broadcast it. A broadcast reaches whoever happens
        //  to be connected AT THAT MOMENT -- refresh the dashboard and the
        //  whole inner voice was gone, because it had only ever existed in
        //  that one page's memory.
        if (typeof args.aside === "string" && args.aside.trim()) {
            if (!Array.isArray(state.asides)) state.asides = [];
            state.asides.push({ text: args.aside.trim(), at: Date.now(), step: state.counters?.currentStep ?? null });
            const ASIDE_KEEP = 200;
            if (state.asides.length > ASIDE_KEEP) {
                state.asides.splice(0, state.asides.length - ASIDE_KEEP);
            }
        }
        broadcast({ type: 'action_start', payload: batchActionStartPayload });
        console.log(`---> Batch Action Start (ID: ${call_id}) - ${args.actions.length} actions`);

        for (let i = 0; i < args.actions.length; i++) {
            const individualAction = args.actions[i];
            const actionCallId = `${call_id}_${i}`;
            let actionResult = {
                action_type: individualAction.type,
                success: false,
                message: "",
                details: "",
            };

            console.log(`---> Executing Action ${i + 1}/${args.actions.length}: ${individualAction.type} (Sub-ID: ${actionCallId})`);
            try {
                switch (individualAction.type) {
                    case "key_press":
                        if (individualAction.keys.includes('start') && individualAction.keys.length > 1) {
                            actionResult.message = "Error: 'start' button cannot be used with other keys.";
                            actionResult.success = false;
                            overallSuccess = false;
                        }
                        else if (keyPressExecutedThisTurn) {
                            actionResult.success = false;
                            actionResult.message = "Error: Only one 'key_press' action is allowed per turn. Include all your keys inside one key_press action. You can send as many actions as you want, but only one key_press action in the list of actions is allowed.";
                            actionResult.details = "Skipping subsequent key_press actions.";
                            overallSuccess = false;
                            console.warn(`WARN: Skipping key_press action ${i + 1} as one was already executed this turn.`);
                        } else if (individualAction.keys && Array.isArray(individualAction.keys) && individualAction.keys.length > 0) {
                            //  DAEMONS: only DIRECTIONAL keys are about movement.
                            //
                            //  a, b, start and select drive menus and dialogue, where
                            //  standing still is the correct outcome. Telling the model
                            //  "YOU DID NOT MOVE -- something is blocking you in that
                            //  direction" after it pressed START to open the options menu
                            //  is not just noise, it is false: nothing blocked anything.
                            //  And the repeat-refusal fired on `a` pressed twice, which is
                            //  how every menu in the game is operated.
                            //
                            //  Watched it happen for five minutes of a run: the agent
                            //  correctly opened OPTION, correctly moved to TEXT SPEED, and
                            //  was told it had walked into a wall every single time.
                            //  There is no menu flag in the game state, so this cannot be
                            //  detected -- only inferred. A run of PURELY directional keys
                            //  is a walk; the moment a confirm button is in the sequence it
                            //  is almost certainly menu navigation, where the arrows move a
                            //  cursor and the player is meant to stand still.
                            const DIRECTIONAL = new Set(["up", "down", "left", "right",
                                "face_up", "face_down", "face_left", "face_right"]);
                            const inDialog = Boolean(gameDataJson?.is_talking_to_npc)
                                || Boolean((gameDataJson?.open_dialog_text || "").trim());
                            const movementIntended = !inDialog
                                && individualAction.keys.length > 0
                                && individualAction.keys.every((k) => DIRECTIONAL.has(k));
                            //  feelings.js needs this exact judgement and was
                            //  making a worse one of its own -- see the note in
                            //  gameLoop where the streak is counted.
                            state.lastMovementIntended = movementIntended;
                            const keySig = JSON.stringify(individualAction.keys);
                            const herePos = gameDataJson?.current_trainer_data?.position || null;
                            const samePlace = Boolean(
                                herePos && blockedAtPosition
                                && herePos.x === blockedAtPosition.x
                                && herePos.y === blockedAtPosition.y
                                && herePos.map_id === blockedAtPosition.map_id
                            );
                            //  Hold the refusal while NOTHING has changed -- same keys, same
                            //  tile, same map -- rather than letting every second attempt
                            //  through. But re-probe every 5th, because a blocked tile is not
                            //  always blocked: an NPC steps aside, and a permanent ban would be
                            //  a worse bug than the loop it fixes.
                            if (movementIntended && keySig === lastBlockedKeys && samePlace && (blockedRefusals % 5) !== 4) {
                                blockedRefusals++;
                                actionResult.success = false;
                                actionResult.message =
                                    `Refused: ${individualAction.keys.join(", ")} is exactly what you`
                                    + " just tried, and it did not move you. Sending it again cannot"
                                    + " work. Pick a DIFFERENT direction, or head for the stairs, a"
                                    + " door or a warp to leave this map.";
                                actionResult.details = "Repeated action blocked before execution.";
                                overallSuccess = false;
                                console.warn(`WARN: refused repeat #${blockedRefusals} of blocked keys ${keySig}`);
                                break;
                            }
                            //  Reset unconditionally: we are about to SEND, so the next
                            //  repeat starts a fresh run of four refusals. Resetting only
                            //  on change let a re-probe through twice in a row.
                            blockedRefusals = 0;

                            //  DAEMONS: report the MOVE, not just the send.
                            //
                            //  The model pressed right ten times at x=11 on a
                            //  map 12 wide -- into the east wall, which cannot
                            //  be walked through -- and did it again the next
                            //  turn. The feedback it got was
                            //  "interruptedByCollision: true" and a
                            //  collisionStreak number, inside a 46k-token
                            //  prompt. That is true and unreadable.
                            //
                            //  So say it plainly: where you were, where you
                            //  are, and if those are the same, that you did
                            //  not move and how big the map is.
                            const beforePos = gameDataJson?.current_trainer_data?.position || null;
                            const response = await sendCommandsToPythonServer(individualAction.keys);
                            actionResult.success = response.status;
                            let moveNote = "";
                            if (movementIntended && response.status && beforePos) {
                                try {
                                    const after = await fetchGameData();
                                    const a = after?.current_trainer_data?.position;
                                    if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) {
                                        if (a.x === beforePos.x && a.y === beforePos.y) {
                                            const grid = after?.minimap_data?.grid;
                                            const size = Array.isArray(grid) && Array.isArray(grid[0])
                                                ? ` This map is ${grid[0].length}x${grid.length}, so x is 0..${grid[0].length - 1} and y is 0..${grid.length - 1}.`
                                                : "";
                                            lastBlockedKeys = keySig;
                                            blockedAtPosition = { x: a.x, y: a.y, map_id: a.map_id };
                                            //  State the FACT and offer both readings. The old
                                            //  wording asserted a wall, and told an agent
                                            //  correctly operating the OPTIONS menu that it had
                                            //  walked into one -- every turn, for five minutes.
                                            moveNote = ` YOU DID NOT MOVE: still at (${a.x}, ${a.y}) on ${a.map_name}.`
                                                + " Either something blocks you in that direction, or you are in a"
                                                + " menu or dialogue where these keys move a cursor rather than the"
                                                + ` player.${size}`
                                                + " If you meant to walk, try a different direction or head for an exit.";
                                        } else {
                                            lastBlockedKeys = null;
                                            blockedAtPosition = null;
                                            blockedRefusals = 0;
                                            moveNote = ` Moved (${beforePos.x}, ${beforePos.y}) -> (${a.x}, ${a.y}).`;
                                        }
                                    }
                                } catch (e) { /* feedback is a bonus, never a failure */ }
                            }
                            actionResult.message = response.status
                                ? `Keys sent: ${individualAction.keys.join(', ')}.${moveNote}`
                                : "Failed to send keys.";
                            actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                            actionResult.details = "";
                            if (actionResult.success) {
                                keyPressExecutedThisTurn = true;
                            } else {
                                overallSuccess = false;
                            }
                        } else {
                            actionResult.message = "Error: 'keys' are missing, empty, or not an array.";
                            actionResult.success = false;
                            overallSuccess = false;
                        }
                        break;

                    case "add_marker":
                        const { map_id, map_name, x, y, emoji, label } = individualAction;
                        const xNum = Number(x);
                        const yNum = Number(y);
                        const xInt = Math.trunc(xNum);
                        const yInt = Math.trunc(yNum);
                        const markerKey = `${xInt}_${yInt}`;
                        if (!state.markers[map_id]) {
                            state.markers[map_id] = {};
                        }

                        // Check if the player is in a dialog, if so, don't add the marker
                        if (gameDataJson.is_talking_to_npc) {
                            actionResult.success = false;
                            actionResult.message = "Error: Player is in a dialog, cannot add a marker. Try again when the dialog is over.";
                            actionResult.details = "Marker not added.";
                            console.log(`INFO: Player is in a dialog, cannot add a marker.`);
                            break;
                        }

                        // Validate coordinates
                        if (!Number.isFinite(xNum) || !Number.isFinite(yNum)) {
                            actionResult.success = false;
                            actionResult.message = `Error: Invalid marker coordinates. x/y must be finite numbers (received x=${x}, y=${y}).`;
                            actionResult.details = "Marker not added.";
                            break;
                        }
                        if (xInt !== xNum || yInt !== yNum) {
                            actionResult.success = false;
                            actionResult.message = `Error: Invalid marker coordinates. x/y must be integers (received x=${x}, y=${y}).`;
                            actionResult.details = "Marker not added.";
                            break;
                        }

                        // Bounds check: prevent out-of-bounds markers on the map.
                        if (xInt < 0 || yInt < 0) {
                            actionResult.success = false;
                            actionResult.message = `Error: Marker (${xInt}, ${yInt}) is out of bounds for map ${map_id}. Coordinates must be >= 0.`;
                            actionResult.details = "Marker not added.";
                            break;
                        }
                        const bounds = await resolveMapBounds(gameDataJson, map_id);
                        if (bounds && (xInt >= bounds.width || yInt >= bounds.height)) {
                            actionResult.success = false;
                            actionResult.message =
                                `Error: Marker (${xInt}, ${yInt}) is out of bounds for map ${map_id} (${bounds.width}x${bounds.height}).`;
                            actionResult.details =
                                `Valid ranges: x=0..${bounds.width - 1}, y=0..${bounds.height - 1}.`;
                            break;
                        }

                        // Check if the marker already exists
                        if (state.markers[map_id][markerKey]) {
                            actionResult.success = false;
                            actionResult.message = `Marker already exists on map ${map_id} at (${xInt}, ${yInt}). Delete it before adding a new one.`;
                            actionResult.details = "Marker not added.";
                            console.log(`INFO: Marker already exists on map ${map_id} at ${markerKey}`);
                            break;
                        }
                        // No static MAP_NAMES table here: map names come from the Python bridge.
                        // We accept the provided map_id/map_name as-is.
                        // Attach NPC/object UID automatically when the marker falls on a known npc_entries position for the current map
                        let markerUid = null;
                        const npcEntries = Array.isArray(gameDataJson?.npc_entries) ? gameDataJson.npc_entries : null;
                        const playerMapId = gameDataJson?.current_trainer_data?.position?.map_id;
                        if (npcEntries && playerMapId === map_id) {
                            for (const entry of npcEntries) {
                                if (!entry || typeof entry !== "object") continue;
                                if (Number(entry.x) === xInt && Number(entry.y) === yInt) {
                                    markerUid = typeof entry.uid === "string" ? entry.uid : null;
                                    break;
                                }
                            }
                        }

                        const markerPayload = markerUid ? { emoji, label, map_name, uid: markerUid } : { emoji, label, map_name };
                        state.markers[map_id][markerKey] = markerPayload;
                        actionResult.success = true;
                        actionResult.message = `Marker added on map ${map_id} at (${xInt}, ${yInt}): ${emoji} ${label}`;
                        actionResult.details = "Marker stored.";
                        console.log(`INFO: Marker stored for map ${map_id} at ${markerKey}`);
                        if (actionResult.success) {
                            broadcast({ type: 'markers_update', payload: state.markers });
                        }
                        break;

                    case "write_memory":
                        if (individualAction.key && typeof individualAction.key === 'string' && typeof individualAction.value === 'string') {
                            state.memory[individualAction.key] = individualAction.value;
                            actionResult.success = true;
                            actionResult.message = `Information memorized: ${individualAction.key}`;
                            console.log(`INFO: Memorization: { ${individualAction.key}: \"${individualAction.value}\" }`);
                            if (actionResult.success) {
                                broadcast({ type: 'memory_update', payload: state.memory });
                            }
                        } else {
                            actionResult.message = "Error: 'key' or 'value' missing or not strings.";
                            actionResult.success = false;
                        }
                        break;

                    case "delete_memory":
                        if (individualAction.key && typeof individualAction.key === 'string') {
                            if (state.memory.hasOwnProperty(individualAction.key)) {
                                delete state.memory[individualAction.key];
                                actionResult.success = true;
                                actionResult.message = `Memory deleted: ${individualAction.key}`;
                                broadcast({ type: 'memory_update', payload: state.memory });
                            } else {
                                actionResult.success = false;
                                actionResult.message = `Error: Key '${individualAction.key}' not found in state.memory.`;
                            }
                        } else {
                            actionResult.message = "Error: 'key' missing or not a string.";
                            actionResult.success = false;
                        }
                        break;
                    case "reflect": {
                        //  The lesson is stored like any other memory, under a
                        //  key that sorts with its siblings, so it is read back
                        //  in the same block the model already consults.
                        const n = Object.keys(state.memory || {}).filter((k) => k.startsWith("learned_")).length + 1;
                        const stamp = gameDataJson?.current_trainer_data?.position?.map_name || "";
                        state.memory[`learned_${String(n).padStart(2, "0")}`] =
                            `${individualAction.learned} (worked: ${individualAction.worked}; `
                            + `wasted: ${individualAction.wasted}${stamp ? "; at " + stamp : ""})`;
                        //  Reflecting IS the objective boundary, so the progress
                        //  delta restarts here -- the next one measures the next
                        //  stretch rather than the whole run.
                        //  The self-portrait, kept apart from the tactical
                        //  memory because it is read back for a different
                        //  reason -- not "what do I know" but "who am I".
                        //  Bounded at six: a self-model is a handful of
                        //  standing observations, not a diary.
                        if (typeof individualAction.about_self === "string"
                            && individualAction.about_self.trim()) {
                            if (!Array.isArray(state.selfModel)) state.selfModel = [];
                            state.selfModel.push({
                                text: individualAction.about_self.trim(),
                                step: state.counters.currentStep,
                            });
                            if (state.selfModel.length > 6) {
                                state.selfModel.splice(0, state.selfModel.length - 6);
                            }
                            console.log(`INFO: [reflect/self] ${individualAction.about_self}`);
                        }
                        state.progressMark = state.progressNow;
                        state.reflectedAtStep = state.counters.currentStep;
                        actionResult.success = true;
                        actionResult.message =
                            `Reflection saved as learned_${String(n).padStart(2, "0")}. `
                            + "The turn-by-turn history before this point can now be dropped; "
                            + "this is what survives it. Set your next objective.";
                        actionResult.details = individualAction.learned;
                        console.log(`INFO: [reflect] ${individualAction.learned}`);
                        break;
                    }
                    case "update_objectives":
                        //  DAEMONS: stamp the map an objective was written on.
                        //
                        //  Objectives go stale silently. "Leave this map by
                        //  using the stairs at (9, 2)" was right in the bedroom
                        //  and actively harmful one floor down, where it sent
                        //  the agent back up the stairs it had just come down.
                        //  The empty-objectives nudge cannot catch that -- the
                        //  block is full, just wrong.
                        //
                        //  A map id is not a judgement about the objective, so
                        //  recording it cannot be wrong the way my exits line
                        //  kept being wrong. The prompt can then say the
                        //  objective was written somewhere else and leave the
                        //  model to decide.
                        state.objectives.map_id = gameDataJson?.current_trainer_data?.position?.map_id || null;
                        state.objectives.map_name = gameDataJson?.current_trainer_data?.position?.map_name || null;
                        let updates = [];
                        let errorOccurred = false;
                        if (individualAction.hasOwnProperty('primary')) {
                            if (typeof individualAction.primary === 'object' && individualAction.primary.short_description && individualAction.primary.description) {
                                state.objectives.primary = individualAction.primary;
                                updates.push(`Primary set.`);
                            } else {
                                actionResult.message = "Error: 'primary' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }
                        if (!errorOccurred && individualAction.hasOwnProperty('secondary')) {
                            if (typeof individualAction.secondary === 'object' && individualAction.secondary.short_description && individualAction.secondary.description) {
                                state.objectives.secondary = individualAction.secondary;
                                updates.push(`Secondary set.`);
                            } else {
                                actionResult.message = "Error: 'secondary' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }

                        if (!errorOccurred && individualAction.hasOwnProperty('third')) {
                            if (typeof individualAction.third === 'object' && individualAction.third.short_description && individualAction.third.description) {
                                state.objectives.third = individualAction.third;
                                updates.push(`Third set.`);
                            } else {
                                actionResult.message = "Error: 'third' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }
                        if (!errorOccurred && individualAction.hasOwnProperty('others')) {
                            if (Array.isArray(individualAction.others) && individualAction.others.every(item => typeof item === 'object' && item.short_description && item.description)) {
                                state.objectives.others = individualAction.others;
                                updates.push(`Others set.`);
                            } else {
                                actionResult.message = "Error: 'others' state.objectives must be an array of objects with a short_description and description.";
                                errorOccurred = true;
                            }
                        }

                        if (!errorOccurred) {
                            if (updates.length > 0) {
                                actionResult.success = true;
                                actionResult.message = "Objectives updated successfully.";
                                actionResult.details = updates.join(" ");
                                console.log(`INFO: Objectives updated. Details: ${actionResult.details}`);
                                broadcast({ type: 'objectives_update', payload: state.objectives });
                            } else {
                                actionResult.success = true;
                                actionResult.message = "No objective fields provided to update.";
                                actionResult.details = "No changes made.";
                            }
                        } else {
                            actionResult.success = false;
                        }
                        break;

                    case "delete_marker":
                        const { map_id: del_map_id, x: del_x, y: del_y } = individualAction;
                        const del_markerKey = `${del_x}_${del_y}`;
                        
                        // Check if the player is in a dialog, if so, don't delete the marker
                        if (gameDataJson.is_talking_to_npc) {
                            actionResult.success = false;
                            actionResult.message = "Error: Player is in a dialog, cannot delete a marker. Try again when the dialog is over.";
                            actionResult.details = "Marker not deleted.";
                            console.log(`INFO: Player is in a dialog, cannot delete a marker.`);
                            break;
                        }

                        if (state.markers[del_map_id] && state.markers[del_map_id][del_markerKey]) {
                            delete state.markers[del_map_id][del_markerKey];
                            if (Object.keys(state.markers[del_map_id]).length === 0) {
                                delete state.markers[del_map_id];
                            }
                            actionResult.success = true;
                            actionResult.message = `Marker deleted from map ${del_map_id} at (${del_x}, ${del_y})`;
                            actionResult.details = "Marker removed.";
                            console.log(`INFO: Marker deleted from map ${del_map_id} at ${del_markerKey}`);
                            broadcast({ type: 'markers_update', payload: state.markers });
                        } else {
                            actionResult.success = false;
                            actionResult.message = `Marker not found on map ${del_map_id} at (${del_x}, ${del_y})`;
                            actionResult.details = "No marker existed.";
                            console.log(`INFO: Attempted to delete non-existent marker at map ${del_map_id}, coords ${del_x}, ${del_y}`);
                        }
                        break;

                    case "path_to_location":
                        const { x: path_x, y: path_y, map_id: path_map_id, explanation: path_explanation } = individualAction;
                        let path = null;
                        let findPathError = null;
                        const maxRetries = 5;
                        //  DAEMONS: refuse arguments that were never parsed properly.
                        //
                        //  mlx-vlm's parameter regex insists on a closing
                        //  </parameter>, so when the model emits a bare "</"
                        //  and moves on, the value runs to the FOLLOWING close
                        //  and swallows the next tag whole. It arrived here as
                        //    x = undefined, y = undefined,
                        //    map_id = "4-1 </ <parameter=explanation> Exploring left..."
                        //  and was dispatched, because nothing between that
                        //  parser and this switch checks anything. The error it
                        //  produced then quoted the XML back inside a sentence
                        //  about maps, which reads as a game bug and is not one.
                        //
                        //  Our own salvage path validates against the schema,
                        //  but a call mlx-vlm parses successfully never reaches
                        //  it -- so the gate belongs here, where every source
                        //  passes through.
                        if (!Number.isFinite(Number(path_x)) || !Number.isFinite(Number(path_y))
                            || typeof path_map_id !== "string" || path_map_id.includes("<")) {
                            actionResult.success = false;
                            actionResult.message =
                                "Error: 'path_to_location' needs a numeric x, a numeric y and a plain map_id"
                                + ` -- got x=${JSON.stringify(path_x)}, y=${JSON.stringify(path_y)},`
                                + ` map_id=${JSON.stringify(path_map_id)}.`
                                + " Close every <parameter> tag with </parameter> and try again.";
                            actionResult.details = "Arguments rejected before pathfinding.";
                            overallSuccess = false;
                            console.warn("WARN: rejected path_to_location with unparseable arguments");
                            break;
                        }
                        console.log(`INFO: Finding path to (${path_x}, ${path_y}) on map ${path_map_id} with explanation: ${path_explanation}`);



                        // Check if the path_to_location action was already executed this turn
                        if (pathfindingExecutedThisTurn) {
                            actionResult.success = false;
                            actionResult.message = "Error: 'path_to_location' action was already executed this turn. Only one 'path_to_location' action is allowed per turn.";
                            actionResult.details = "Skipping subsequent path_to_location actions.";
                            overallSuccess = false; // Mark overall success as false
                            break;
                        }

                        let pathAttempts = 0;
                        for (let attempt = 1; attempt <= maxRetries; attempt++) {
                            pathAttempts = attempt;
                            try {
                                console.log(`INFO: Attempt ${attempt}/${maxRetries} to find path to (${path_x}, ${path_y}) on map ${path_map_id}`);
                                path = await findPath(path_x, path_y, path_map_id, path_explanation);
                                console.log(`INFO: Path found on attempt ${attempt}: ${path.keys}`);
                                findPathError = null; // Clear error on success
                                break; // Exit loop if path found successfully
                            } catch (error) {
                                console.error(`ERROR: Attempt ${attempt} failed for findPath(${path_x}, ${path_y}):`, error.message);
                                findPathError = error; // Store the last error
                                // Check if the error message contains "Player is not on map"
                                //  A BFS is deterministic: retrying it four
                                //  more times produces the same refusal and
                                //  four more identical log lines.
                                if (error.message.startsWith("No walkable route")) {
                                    actionResult.success = false;
                                    actionResult.message = error.message;
                                    break;
                                }
                                if (error.message.includes("Player is not on map")) {
                                    console.error(`ERROR: Player is not on map ${path_map_id}.`);
                                    actionResult.success = false;
                                    actionResult.message = `Player is not on map ${path_map_id}.`;
                                    break;
                                }
                                if (attempt === maxRetries) {
                                    console.error(`ERROR: findPath failed after ${maxRetries} attempts.`);
                                } else {
                                    // Optional: Add a small delay before retrying
                                    // await new Promise(resolve => setTimeout(resolve, 500));
                                }
                            }
                        }

                        //  DAEMONS: an empty path is not a failed path when you
                        //  are already standing on the target. planPath returns
                        //  zero keys for that, and the check below reads zero
                        //  keys as "No path found or path was empty" -- so
                        //  arriving reported as an error, which is both wrong
                        //  and the sort of thing that teaches the model its
                        //  correct move failed.
                        if (path && Array.isArray(path.keys) && path.keys.length === 0) {
                            pathfindingExecutedThisTurn = true;
                            actionResult.success = true;
                            actionResult.message =
                                `You are ALREADY standing on (${path_x}, ${path_y}) -- no movement needed.`
                                + " If this was meant to be an exit, use it now: on a carpet or warp,"
                                + " press toward the adjacent wall; on a door or stairs, step into it.";
                            actionResult.details = path.explanation || "";
                            break;
                        }
                        if (path && path.keys && path.keys.length > 0) {
                            pathfindingExecutedThisTurn = true;
                            
                            const gameDataJson = await fetchGameData();
                            let finalKeysList = path.keys;
                            // Check if we are in a dialogue
                            if (gameDataJson.is_talking_to_npc) {
                                console.log(`Dialogue detected while calculating path, adding a_until_end_of_dialog to the path.`);
                                finalKeysList = ["a_until_end_of_dialog", ...path.keys];
                            }
                            const response = await sendCommandsToPythonServer(finalKeysList);
                            actionResult.success = response.status;
                            actionResult.message = response.status
                                ? `Explanation: ${path.explanation} \nKeys sequence generated by the path finding tool: "${path.keys.join(', ')}"`
                                : "Failed to send keys.";
                            const logs = summarizeTracePayloadMarkdown(response);
                            actionResult.details = `Keys execution result: ${logs || ""}`;
                        } else {
                            actionResult.success = false;
                            actionResult.message = findPathError
                                ? `Failed to find path to (${path_x}, ${path_y}) after ${pathAttempts} attempt${pathAttempts === 1 ? "" : "s"}. Last error: ${findPathError.message}`
                                : `No path found or path was empty to (${path_x}, ${path_y}) \nExplanation: ${path.explanation}`;
                            actionResult.details = findPathError ? findPathError.stack : "Pathfinding logic returned empty path.";
                        }
                        break;
                    case "restart_console":
                        const restartResponse = await requestConsoleRestart();
                        // Wait 15 seconds before returning the result
                        await new Promise(resolve => setTimeout(resolve, 15000));
                        await sendCommandsToPythonServer(["a_until_end_of_dialog"]);
                        if (restartResponse?.status) {
                            actionResult.success = true;
                            actionResult.message = restartResponse.message || "Console restart requested successfully.";
                            actionResult.details = restartResponse.details || "";
                        } else {
                            actionResult.success = false;
                            actionResult.message = restartResponse?.message || "Error: Failed to restart the console.";
                            actionResult.details = restartResponse?.details || "";
                            overallSuccess = false;
                        }
                        break;
                    default:
                        actionResult.success = false;
                        actionResult.message = `Error: Unknown action type '${individualAction.type}'.`;
                }
            } catch (actionError) {
                // Catch errors specific to executing this single action
                console.error(`Error executing action type ${individualAction.type}:`, actionError);
                actionResult.success = false;
                actionResult.message = `Execution error for ${individualAction.type}: ${actionError.message}`;
                actionResult.details = actionError.stack;
            }
            // --- End Action Execution Logic ---

            const actionResultPayload = {
                call_id: actionCallId,
                action_type: individualAction.type,
                success: actionResult.success,
                message: actionResult.message,
                details: actionResult.details,
            };
            broadcast({ type: 'action_executed', payload: actionResultPayload });
            console.log(`<--- Action ${i + 1}/${args.actions.length} End: ${individualAction.type} (Sub-ID: ${actionCallId}) - Success: ${actionResult.success} ---`);


            // Store the result and update overall success
            allActionResults.push(actionResult);
            if (!actionResult.success) {
                overallSuccess = false;
                console.warn(`Action ${i + 1} (${individualAction.type}) failed. Subsequent actions in this step will still be attempted.`);
                // Optional: break here if you want to stop processing on the first failure
                // break;
            }
        }

    } catch (error) {
        // Catch errors from JSON parsing or initial validation before the loop
        overallSuccess = false;
        const errorMessage = `Tool call processing error (pre-execution): ${error.message}`;
        console.error(errorMessage, error);
        broadcast({ type: 'error_message', payload: errorMessage });
        // Add a placeholder result if no actions were even attempted
        if (allActionResults.length === 0) {
            allActionResults.push({
                action_type: 'setup_error',
                success: false,
                message: errorMessage,
                details: error.stack
            });
        }
    } finally {
        const durationMs = Date.now() - toolBatchStart;
        recordToolBatch({ callId: call_id, durationMs });
    }

    console.log(`<--- Tool Call End: ${name} (ID: ${call_id}) - Overall Success: ${overallSuccess} ---`);

    // Summarize the full action batch for the OpenAI history entry.
    const output = allActionResults
        .map((res) => {
            const details = res.details_for_ai != null ? res.details_for_ai : res.details;
            return `
    <action_result type="${xmlAttr(res.action_type)}" success="${res.success ? "true" : "false"}">
      <message>${xmlEscape(res.message || "")}</message>
      ${details ? `<details>${xmlEscape(details)}</details>` : ""}
    </action_result>
    `.trim();
        })
        .join("\n");

    // Return the formatted result for the OpenAI history
    return {
        type: "function_call_output",
        call_id: call_id, // Use the original call_id here too
        output: toolOutput(output.trim()),
    };
}

async function findPath(x, y, map_id, explanation) {
    const gameDataJson = await fetchGameData();

    //  DAEMONS: solve it here unless explicitly told not to.
    //
    //  Everything below this branch runs on OpenAI's Code Interpreter --
    //  openai.containers.create() and hardcoded api.openai.com container URLs
    //  that no base-URL setting redirects -- so against a local model it fails
    //  five times and stalls the run. The grid it would reason about is
    //  already in gameDataJson, so a BFS answers exactly, instantly, and
    //  without a network call. DAEMONS_PATHFINDER=openai restores upstream's.
    if ((process.env.DAEMONS_PATHFINDER || "local") !== "openai") {
        const { position } = gameDataJson.current_trainer_data;
        if (position.map_id !== map_id) {
            throw new Error(`Player is not on map ${map_id}. Current map: ${position.map_id}`);
        }
        if (gameDataJson.is_talking_to_npc) {
            throw new Error("Player is in a dialogue. Cannot find path.");
        }
        const planned = planPath(gameDataJson, x, y);
        console.log(`INFO: [local BFS] ${planned.explanation}`);
        return { keys: planned.keys, explanation: planned.explanation };
    }

    const pathfindingStart = Date.now();
    const { current_trainer_data } = gameDataJson;
    const { position } = current_trainer_data;

    // Check if the player map_id is the same as the map_id
    if (position.map_id !== map_id) {
        console.log(`ERROR: Player is not on map ${map_id}. Current map: ${position.map_id}`);
        throw new Error(`Player is not on map ${map_id}. Current map: ${position.map_id}`);
    }

    // Check if we are in a dialogue
    if (gameDataJson.is_talking_to_npc) {
        console.log(`ERROR: Player is in a dialogue. Cannot find path.`);
        throw new Error(`Player is in a dialogue. Cannot find path.`);
    }
    console.log(`INFO: Finding path to (${x}, ${y}) on map ${position.map_name} (${position.map_id})`);

    const gameAreaGrid = Array.isArray(gameDataJson.game_area_meta_tiles) ? gameDataJson.game_area_meta_tiles : [];
    const gameAreaH = gameAreaGrid.length;
    const gameAreaW = gameAreaH > 0 && Array.isArray(gameAreaGrid[0]) ? gameAreaGrid[0].length : 0;
    const origin = gameDataJson?.visible_area_data?.origin || null;
    let localRow = Number(position.y) - Number(origin?.y);
    let localCol = Number(position.x) - Number(origin?.x);
    if (!Number.isFinite(localRow) || localRow < 0 || localRow >= gameAreaH) {
        localRow = gameAreaH ? Math.floor(gameAreaH / 2) : 0;
    }
    if (!Number.isFinite(localCol) || localCol < 0 || localCol >= gameAreaW) {
        localCol = gameAreaW ? Math.floor(gameAreaW / 2) : 0;
    }

    const playerOrientationId = gameDataJson?.minimap_data?.orientation ?? null;
    const minimapDisplay = minimapToMarkdown(
        gameDataJson.minimap_data,
        position.x,
        position.y,
        position.map_id,
        position.map_name,
        playerOrientationId,
        gameAreaGrid,
        localRow,
        localCol,
        gameDataJson?.npc_entries ?? null,
        true
    );

    let minimapMarkdown = `

<strength_status>
    Strength ability active (can push boulders): ${gameDataJson.strength_enabled}
</strength_status>

<movement_mode>
    Current player movement mode: ${gameDataJson.player_movement_mode}
</movement_mode>

<environment>
    <current_map>
    ${minimapDisplay}
    </current_map>
</environment>

<target_location>
    <x>${x}</x>
    <y>${y}</y>
</target_location>

<explanation>
${explanation}
</explanation>

<full_legend>
${formatTilesLegend()}
</full_legend>

<json_file_content>
${JSON.stringify(gameDataJson.minimap_data.grid, null, 2)}
</json_file_content>

<updated_code_instructions>
- If you modify or add pathfinding logic, write the FULLY UPDATED Python code into a **new file inside the container** under \`/mnt/data\` (e.g., \`/mnt/data/updated_pathfinder.py\`).
- Do NOT edit the 'uploaded_python_file' directly. Instead, copy it, make your changes to the copy, and specify the new file path in the 'updated_code_path' key.
- Always clean and optimize the code when editing: improve docstrings and comments, remove duplicate code, and refine usage examples.
- You may create multiple functions (e.g., 'plan_path', 'move_boulders', etc.). You don't need to combine everything into a single function—just ensure each function is well-documented with clear usage instructions.
- If you reuse the existing uploaded code without any modifications, do NOT create a new file. Simply return an empty \`updated_code_path\`.
- The file must remain runnable as a reusable module that can dynamically load the grid JSON and accept start/end coordinates as parameters.
- Always include all code in a single file. Do NOT split it into multiple files.
- Preserve all working features. Add comments and docstrings for clarity and usage guidance.
- The file must be ready to be imported and executed as a module using \`importlib.util.spec_from_file_location\` and \`importlib.util.module_from_spec\`.
- Always verify whether the current code handles the situation you are facing. If the code does not cover your current scenario, update it to handle that situation.
- Always update the code when you use a new function that was not in the previous code. It's important to keep the code up to date and functional to avoid redoing it later.
- CRITICAL: Never delete existing code or logic simply because it's not needed for the immediate situation. The code has been built incrementally throughout the journey and must be preserved. You should ONLY "enhance", "add features", or "optimize" the existing code—never replace it with situation-specific code that discards previous functionality.
</updated_code_instructions>

    `;

    const pathFindingPrompt = await fs.readFile(path.join(config.promptsDir, "path_finding.txt"), "utf8");

    await new Promise(setImmediate); // Allow event loop before potentially long API call

    let container = null;
    try {
        container = await openai.containers.create({
            name: "pathfinding-container"
        });
        console.log("✅ Container created:", container.id);
    } catch (error) {
        console.error("❌ Failed to create container:", error.message);
        throw error;
    }


    setIsThinking(true);
    // Load the last full working code (if exists and not empty)
    let lastFullWorkingCode = null;
    let uploadedPyFile = null;
    if (fsSync.existsSync(path.join(__dirname, '..', '..', 'tmp', 'temp_full_working_code.py'))) {
        const lastFullWorkingCodePath = path.join(__dirname, '..', '..', 'tmp', 'temp_full_working_code.py');
        lastFullWorkingCode = await fs.readFile(lastFullWorkingCodePath, 'utf8');
        console.log(`Last full working code loaded from ${lastFullWorkingCodePath}`);

        // Upload the Python file to the container
        try {
            const pyFormData = new FormData();
            pyFormData.append('file', fsSync.createReadStream(lastFullWorkingCodePath));

            const pyResponse = await axios.post(
                `https://api.openai.com/v1/containers/${container.id}/files`,
                pyFormData,
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                        ...pyFormData.getHeaders()
                    }
                }
            );

            uploadedPyFile = pyResponse.data;
            console.log("✅ Python file uploaded successfully:", uploadedPyFile.path);
        } catch (error) {
            console.error("❌ Failed to upload Python file:", error.response?.data || error.message);
            // Continue even if Python file upload fails
        }
    }
    let uploadedFile = null;
    try {
        const mapGridData = gameDataJson.minimap_data.grid;
        const mapGridPath = path.join(__dirname, '..', '..', 'tmp', 'temp_map_grid.json');

        // Write the grid data to a temporary JSON file
        await fs.writeFile(mapGridPath, JSON.stringify(mapGridData, null, 2));
        const formData = new FormData();
        formData.append('file', fsSync.createReadStream(mapGridPath));

        const response = await axios.post(
            `https://api.openai.com/v1/containers/${container.id}/files`,
            formData,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    ...formData.getHeaders()
                }
            }
        );

        uploadedFile = response.data;
        console.log("✅ File uploaded successfully:", uploadedFile.path);
    } catch (error) {
        console.error("❌ Failed to upload file:", error.response?.data || error.message);
        throw error;
    }

    if (lastFullWorkingCode) {
        minimapMarkdown += "\n\n<last_full_working_code>\n**PRIORITY: Try this working code first (fast path)**\n\n" +
            "Execute the code below ONCE with current inputs:\n" +
            "1. Update ONLY: map JSON file path and coordinates\n" +
            "2. Run immediately—no refactoring, optimization, or non-trivial changes\n" +
            "3. If scenario requires mechanics this code doesn't support (spinners, boulders, etc.), skip to fresh implementation\n\n" +
            "**Success criteria:** Non-empty path in correct format, respects all rules\n" +
            "→ Output the path and STOP. No verification or commentary needed.\n\n" +
            "**Failure conditions:** Error, empty/invalid path, rule violations, or requires non-trivial adaptation\n" +
            "→ Abandon this code immediately. Write new solution from scratch.\n\n" +
            "**Time budget:** Minimal. Single execution only—no iteration or tuning.\n\n" +
            uploadedPyFile.path + "\n```python\n" + lastFullWorkingCode + "\n```\n</last_full_working_code>";

        minimapMarkdown += `\n\n<uploaded_python_file>\nFile: ${uploadedPyFile.path}\n</uploaded_python_file>
    
    <execution_workflow>
    **CRITICAL: Always execute code before manual reasoning**
    
    Step 1: Run the Python file first
    Step 2: After execution (success or failure), analyze results
    Step 3: If needed, think through logic, corrections, or missing mechanics
    
    This sequence saves significant time and effort.
    </execution_workflow>
    
    <python_file_usage_example>
    Reuse existing code with different inputs instead of rewriting. Adapt this template to your actual function names:
    
    \`\`\`python
    import importlib.util, json, sys
    
    # Load the user's Python module dynamically
    py_path = "${uploadedPyFile.path}"
    json_path = "${uploadedFile.path}"
    
    spec = importlib.util.spec_from_file_location("pathfinding_code", py_path)
    pathfinding_code = importlib.util.module_from_spec(spec)
    sys.modules["pathfinding_code"] = pathfinding_code
    spec.loader.exec_module(pathfinding_code)
    
    # Load grid and run pathfinding (adapt to actual functions)
    grid = pathfinding_code.load_grid(json_path)
    start = (11, 82)  # (x, y)
    goal = (10, 2)    # (x, y)
    keys = pathfinding_code.astar(grid, start, goal)
    
    # Optional diagnostics
    height = len(grid)
    width = len(grid[0]) if height > 0 else 0
    reachable = bool(keys) or start == goal
    \`\`\`
    </python_file_usage_example>`;
    }

    const stream = openai.responses.stream({
        model: config.openai.modelPathFinding,
        service_tier: config.openai.service_tierPathfinding,
        input: [
            {
                "role": "developer",
                "content": pathFindingPrompt + "\n\nPathfinding policy:\n- The current map grid JSON is at: " + uploadedFile.path + ".\n- If you reuse the uploaded Python as-is, return an empty 'updated_code_path'.\n- If you modify or add code, save it inside the container under /mnt/data (e.g., /mnt/data/updated_pathfinder.py) and return that path in 'updated_code_path'.\n- Do NOT paste code in the JSON output.\n- Use the tool judiciously to avoid unnecessary runtime."
            },
            {
                "role": "user", "content": [
                    {
                        type: "input_text",
                        text: minimapMarkdown
                    }
                ]
            }
        ],
        reasoning: {
            summary: config.openai.reasoningSummary,
            effort: config.openai.reasoningEffortPathfinding,
        },
        store: false,
        include: ["reasoning.encrypted_content", "code_interpreter_call.outputs"],
        tools: [
            {
                type: "code_interpreter",
                container: container.id
            }
        ],
        text: {
            format: {
                type: "json_schema",
                name: "path",
                schema: {
                    type: "object",
                    properties: {
                        keys: {
                            // Array of Enum of keys
                            type: "array",
                            items: {
                                type: "string",
                                enum: ["up", "down", "left", "right"]
                            }
                        },
                        explanation: {
                            type: "string",
                            description: "Explanation of your path - a brief summary of the route you took and your reasoning. If the target was unreachable, explain why and describe which nearby tile you selected instead. Include detailed information so the user fully understands the situation and doesn't think the pathfinding tool malfunctioned when it doesn't reach the exact target."
                        },
                        updated_code_path: {
                            type: "string",
                            description: "Absolute path (inside the container) to a newly created/updated Python file in /mnt/data when you changed the pathfinding code. Return an empty string if no code changes were made. Do not include code here."
                        }
                    },
                    required: ["keys", "explanation", "updated_code_path"],
                    additionalProperties: false,
                },
                strict: true,
            }
        }
    });

    // --- Use for-await to process events ---
    for await (const event of stream) {
        switch (event.type) {
            case "response.reasoning_summary_part.done":
                broadcast({ type: 'reasoning_chunk', payload: "\n\n" });
                process.stdout.write("\n\n");
                break;
            case "response.output_item.done":
                if (event.item.type === "reasoning" || event.item.type === "output_text") {
                    console.log("--------------------");
                }
                break;
            case "response.reasoning_summary_text.delta":
                process.stdout.write(event.delta);
                broadcast({ type: 'reasoning_chunk', payload: event.delta });
                break;
            case "response.completed":
                // Do nothing, will use stream.finalResponse() after loop
                break;
            case "response.code_interpreter_call.in_progress":
                // The code is going to be written, do nothing
                // process.stdout.write("\n```python\n");
                broadcast({ type: 'reasoning_chunk', payload: "\n```python\n" });
                break;
            case "response.code_interpreter_call.interpreting":
                // The code is being interpreted, do nothing
                // process.stdout.write("\n```\n\n");
                broadcast({ type: 'reasoning_chunk', payload: "\n```\n\n" });
                break;
            case "response.code_interpreter_call_code.delta":
                // Do nothing, will be logged in the code_interpreter_call_code.done event
                // Example of event:
                // Event: {
                //     "type": "response.code_interpreter_call_code.delta",
                //     "sequence_number": 3391,
                //     "output_index": 3,
                //     "item_id": "ci_0953e4bb8232b81a0168f8d4528bf8819582fea32ed3d9d8f8",
                //     "delta": "=",
                //     "obfuscation": "V3NniqRN3T3kRdS"
                //   }
                if (event.delta) {
                    // process.stdout.write(event.delta); 
                    broadcast({ type: 'reasoning_chunk', payload: event.delta });
                }
                break;
            case "response.code_interpreter_call_code.done":
                if (event.code) {
                    process.stdout.write("````python\n" + event.code + "\n````\n\n");
                    // broadcast({ type: 'reasoning_chunk', payload: "````python\n" + event.code + "\n````\n\n" });
                }
                break;
            default:
                // Optionally log or handle unknown event types

                // console.log("Unknown event type:", event.type);
                // console.log("Event:", JSON.stringify(event, null, 2));
                break;
        }
    }

    // After streaming, get the final response
    const response = await stream.finalResponse();
    const pathfindingDuration = Date.now() - pathfindingStart;
    recordReasoningTime({
        type: "pathfinding",
        model: config.openai.modelPathFinding,
        serviceTier: config.openai.service_tierPathfinding,
        durationMs: pathfindingDuration,
    });
    // broadcast({ type: 'pathfinding_stream_end', payload: null });

    setIsThinking(false);
    const criticismCost = calculateRequestCost(response.usage, config.openai.modelPathFinding, config.openai.tokenPrice, config.openai.service_tierPathfinding);
    if (criticismCost !== null) {
        console.log(`Estimated Cost: $${criticismCost.fullCost} (Discounted: $${criticismCost.discountedCost})`);
        broadcast({ type: 'token_usage', payload: { ...response.usage, cost: criticismCost.fullCost, discountedCost: criticismCost.discountedCost } });
    } else {
        broadcast({ type: 'token_usage', payload: response.usage });
    }
    console.log("Response:", JSON.stringify(response, null, 2));

    const event = JSON.parse(response.output.find(item => item.type === "message").content.find(item => item.type === "output_text").text);
    const fullWorkingCodePath = path.join(__dirname, '..', '..', 'tmp', 'temp_full_working_code.py');
    if (event.updated_code_path) {
        try {
            const listResponse = await axios.get(`https://api.openai.com/v1/containers/${container.id}/files`, {
                headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
            });

            const updatedFile = listResponse.data?.data?.find(file => file.path === event.updated_code_path);
            if (!updatedFile) {
                throw new Error(`Updated code file not found at path ${event.updated_code_path}`);
            }

            const fileContentResponse = await axios.get(`https://api.openai.com/v1/containers/${container.id}/files/${updatedFile.id}/content`, {
                headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                responseType: 'arraybuffer'
            });

            await fs.writeFile(fullWorkingCodePath, fileContentResponse.data);
            console.log(`Updated working code downloaded from ${event.updated_code_path} to ${fullWorkingCodePath}`);
        } catch (downloadError) {
            console.error("❌ Failed to download updated code:", downloadError.response?.data || downloadError.message);
        }
    } else {
        console.log("No updated code provided by pathfinding model.");
    }
    return event;
}

/**
 * Updates progress steps based on current game state
 * @param {object} gameDataJson - The current game data
 */

module.exports = { defineTools, handleToolCall, findPath };
