const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { config } = require('../config');
const { state, setIsThinking, savePersistentState } = require('../state/stateManager');
const { broadcast } = require('../core/socketHub');
const { calculateRequestCost } = require('../utils/costs');
const { fetchGameData } = require('../services/pythonService');
const { buildVisionPayload } = require('../services/screenshotService');
const { buildUserInputText, buildDeveloperPrompt } = require('../ai/promptBuilder');
const { processHistoryForAPI } = require('../ai/historyProcessor');
const { defineTools, handleToolCall } = require('../ai/tools');
const { salvageToolCalls } = require('../ai/salvageToolCall.js');
const progress = require('./progress.js');
const { updateProgressSteps, updateLastVisitedMaps } = require('./progressTracker');
const { openai } = require('./openaiClient');
const { startLoop, recordLoopUsage, flush, getCumulativeTotals } = require('../utils/tokenUsageTracker');
const {
    startLoop: startTimeLoop,
    recordReasoning,
    recordToolBatch,
    recordDownTime,
    recordTotal,
    flush: flushTime,
    getCumulativeTotals: getCumulativeTimeTotals,
} = require('../utils/timeTracker');

// Keep markers with NPC-linked UIDs in sync with current npc_entries positions
// Returns true if any marker was moved
function reconcileMarkersWithNpcEntries(gameDataJson) {
    const npcEntries = Array.isArray(gameDataJson?.npc_entries) ? gameDataJson.npc_entries : null;
    const currentMapId = gameDataJson?.current_trainer_data?.position?.map_id;
    if (!npcEntries || !currentMapId) return false;

    const mapMarkers = state.markers[currentMapId];
    if (!mapMarkers || Object.keys(mapMarkers).length === 0) return false;

    const npcByUid = new Map();
    for (const entry of npcEntries) {
        if (entry?.uid) npcByUid.set(entry.uid, entry);
    }

    let updated = false;
    for (const markerKey of Object.keys(mapMarkers)) {
        const marker = mapMarkers[markerKey];
        if (!marker || !marker.uid) continue; // Only sync markers that are tied to a npc_entries UID

        const npc = npcByUid.get(marker.uid);
        if (!npc) continue; // UID no longer present; leave marker untouched for now

        const [mx, my] = markerKey.split('_').map(Number);
        if (npc.x !== mx || npc.y !== my) {
            // Move marker to NPC's new position
            delete mapMarkers[markerKey];
            const newKey = `${npc.x}_${npc.y}`;
            mapMarkers[newKey] = { ...marker };
            updated = true;
            console.log(`Markers sync: moved UID ${marker.uid} from (${mx}, ${my}) to (${npc.x}, ${npc.y}) on map ${currentMapId}`);
        }
    }

    if (updated) {
        state.markers[currentMapId] = mapMarkers;
        broadcast({ type: 'markers_update', payload: state.markers });
    }

    return updated;
}

//  DAEMONS: how many times running the summary has come back unusable.
//  The gate below used to `continue` on a bad summary WITHOUT advancing
//  lastSummaryStep, so `shouldSummarize` was still true on the next pass and
//  the run summarised forever, never playing another step. A run stopped dead
//  at step 120 -- the threshold exactly -- with lastSummaryStep still 0.
let summaryAttempts = 0;

async function gameLoop() {
    while (true) {
        const loopStartTime = Date.now(); // track per-iteration timing across try/catch/finally
        try {
            // <<< ADDED YIELD >>>
            await new Promise(setImmediate); // Allow event loop processing at the start
            startLoop(state.counters.currentStep);
            startTimeLoop(state.counters.currentStep);

            // Broadcast cumulative token usage at the start of each loop iteration.
            // Use `total_tokens` from persisted data (do not recompute from input/output).
            try {
                const totals = await getCumulativeTotals();
                broadcast({
                    type: 'token_usage_total',
                    payload: {
                        ...totals,
                        step: state.counters.currentStep,
                        discountedCost: totals.discounted_cost,
                        input_tokens_details: { cached_tokens: totals.cached_input_tokens },
                    },
                });
            } catch (error) {
                console.warn("Failed to broadcast cumulative token usage totals:", error);
            }

            // Broadcast cumulative time usage at the start of each loop iteration.
            try {
                const totals = await getCumulativeTimeTotals();
                broadcast({
                    type: 'time_usage_total',
                    payload: {
                        ...totals,
                        step: state.counters.currentStep,
                    },
                });
            } catch (error) {
                console.warn("Failed to broadcast cumulative time usage totals:", error);
            }

            let newUserMessage = null;
            let responseCompleted = false;
            setIsThinking(true);
            state.selfCritiqueReminderAcknowledged = false; // Reset reminder delivery flag for this iteration
            // 0. Short pause (optional)
            if (config.loopDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, config.loopDelayMs));
            }
            // 1. Get the current game state
            const gameDataJson = await fetchGameData();
            //  DAEMONS: score the run every turn. This is for JUDGING runs --
            //  yesterday every model comparison was "seems better", and the one
            //  time it was measured the conclusion reversed twice. The model
            //  never sees this number; it sees the delta in words.
            const progressPrev = state.progressNow;
            state.progressNow = progress.snapshot(gameDataJson, state);
            if (!state.progressMark) state.progressMark = state.progressNow;
            state.progressScore = progress.score(state.progressNow);

            //  FEELINGS. Same snapshot, read for a different question: not
            //  "how far has it got" but "what just happened to it". Derived
            //  here rather than asked of the model, for the reason the whole
            //  file keeps relearning -- read the game's data and you are right
            //  the first time.
            {
                const feelings = require("./feelings.js");
                const party = Array.isArray(gameDataJson?.current_pokemon_data)
                    ? gameDataJson.current_pokemon_data : [];
                const hpNow = party.reduce((a, p) => a + (Number(p?.current_hp) || 0), 0);
                const hpMax = party.reduce((a, p) => a + (Number(p?.max_hp) || 0), 0);
                const hpFraction = hpMax > 0 ? hpNow / hpMax : null;

                //  A blocked move is only frustrating when it REPEATS, so the
                //  streak is the signal and a single bump is not.
                const here = `${gameDataJson?.current_trainer_data?.position?.map_id}:`
                    + `${gameDataJson?.current_trainer_data?.position?.x},`
                    + `${gameDataJson?.current_trainer_data?.position?.y}`;
                if (state.lastFeelPos === here) state.blockedStreak = (state.blockedStreak || 0) + 1;
                else state.blockedStreak = 0;
                state.lastFeelPos = here;

                const { deltas, events } = feelings.readEvents(progressPrev, state.progressNow, {
                    hpFraction,
                    prevHpFraction: state.lastHpFraction,
                    blockedStreak: state.blockedStreak,
                });
                state.feelings = feelings.step(state.feelings || feelings.zero(), deltas);

                //  A CHECKPOINT releases the survival axes. Detected off the
                //  map name, which is now CHECKPOINT everywhere thanks to the
                //  rename -- and only on ARRIVAL, not every turn spent inside.
                const mapName = String(gameDataJson?.current_trainer_data?.position?.map_name || "");
                const inCheckpoint = /CHECKPOINT/.test(mapName);
                if (inCheckpoint && !state.wasInCheckpoint) {
                    state.feelings = feelings.checkpoint(state.feelings);
                    events.push({ axis: "PHLEGMATIC", n: 0, why: "reached a CHECKPOINT" });
                }
                state.wasInCheckpoint = inCheckpoint;
                state.lastHpFraction = hpFraction;
                state.feelingEvents = events;
                if (events.length) {
                    console.log(`  feelings: ${feelings.describe(state.feelings)
                        .map((f) => f.phrase).join(", ") || "level"}`
                        + `   (${events.map((e) => e.why).join(", ")})`);
                }
            }
            state.gameDataJsonRef = gameDataJson; // <<< Store latest game data
            if (!gameDataJson) {
                console.error("Could not retrieve game data. Pausing and retrying...");
                broadcast({ type: 'error_message', payload: 'Failed to retrieve game data from Python server.' });
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
                continue; // Restart the loop
            }
            // Keep markers with NPC-linked UIDs aligned to their latest positions
            const markersMoved = reconcileMarkersWithNpcEntries(gameDataJson);
            if (markersMoved) {
                // Persist immediately so we don't repeat the move next loop
                await savePersistentState();
            }
            // console.log("Game data received:", gameDataJson); // Debug
            await fs.writeFile(config.paths.gameDataJsonFile, JSON.stringify(gameDataJson, null, 2));

            // --- Update Last Visited Maps ---
            const mapId = gameDataJson.current_trainer_data?.position?.map_id;
            const mapName = gameDataJson.current_trainer_data?.position?.map_name;
            const lastVisitedMapsUpdated = updateLastVisitedMaps(mapId, mapName);
            if (lastVisitedMapsUpdated) {
                // Broadcast the updated list to connected clients
                // broadcast({
                //     type: 'last_visited_maps_update',
                //     payload: state.lastVisitedMaps
                // });
                console.log(`>>> LAST VISITED MAPS UPDATED: Now visiting ${mapName} (${mapId}) <<<`);
            }
            // --- End Last Visited Maps Update ---

            // --- Check for Badge Updates ---
            const currentBadges = gameDataJson.current_trainer_data?.badges || {}; // Handle potential missing badges
            if (currentBadges && typeof currentBadges === 'object' && !Array.isArray(currentBadges)) {
                const nowIso = new Date().toISOString();

                // Ensure badgeHistory contains *all* known badges (including not obtained yet).
                for (const [badgeId, rawHave] of Object.entries(currentBadges)) {
                    const have = Boolean(rawHave);
                    const existing = state.badgeHistory?.[badgeId];

                    if (existing && typeof existing === "object" && !Array.isArray(existing) && typeof existing.obtained === "boolean") {
                        // ok
                    } else if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                        // Back-compat: old format stored only {step,timestamp} for obtained badges.
                        state.badgeHistory[badgeId] = {
                            obtained: true,
                            step: typeof existing.step === "number" ? existing.step : null,
                            timestamp: typeof existing.timestamp === "string" ? existing.timestamp : null,
                        };
                    } else {
                        state.badgeHistory[badgeId] = {
                            obtained: have,
                            step: have ? state.counters.currentStep : null,
                            timestamp: have ? nowIso : null,
                        };
                    }
                }

                // Only report "just obtained" when we're not inside a dialog / fight and the map is valid.
                if (!gameDataJson.is_talking_to_npc && !gameDataJson.is_in_battle && mapName != "0-0") {
                    for (const [badgeId, rawHave] of Object.entries(currentBadges)) {
                        const have = Boolean(rawHave);
                        if (have === true && !state.previousBadgesState[badgeId]) {
                            state.badgeHistory[badgeId] = {
                                obtained: true,
                                step: state.counters.currentStep,
                                timestamp: nowIso,
                            };
                            console.log(`>>> BADGE OBTAINED: ${badgeId} at step ${state.counters.currentStep} <<< `);
                            // broadcast({ type: 'badge_obtained', payload: { badgeName: badgeId, info: state.badgeHistory[badgeId] } });
                        }
                    }
                }

                // Update previous state for the next iteration.
                const nextPrev = {};
                for (const [badgeId, rawHave] of Object.entries(currentBadges)) {
                    nextPrev[badgeId] = Boolean(rawHave);
                }
                state.previousBadgesState = nextPrev;
            } else {
                console.warn("Badge data missing or invalid in gameDataJson.current_trainer_data");
            }
            // --- End Badge Update Check ---

            // --- Check for Map First Visit ---
            const currentMapId = gameDataJson.current_trainer_data?.position?.map_id;
            if (!state.mapVisitHistory[currentMapId] && currentMapId != "0-0") {
                const visitInfo = {
                    map_name: gameDataJson.current_trainer_data?.position?.map_name,
                    step: state.counters.currentStep,
                    timestamp: new Date().toISOString()
                };
                state.mapVisitHistory[currentMapId] = visitInfo;
                console.log(`>>> FIRST VISIT TO MAP: ${currentMapId} (${gameDataJson.current_trainer_data?.position?.map_name}) at step ${state.counters.currentStep} <<< `);
            }
            // --- End Map First Visit Check ---

            // --- Update Progress Steps ---
            const progressUpdated = updateProgressSteps(gameDataJson);
            if (progressUpdated) {
                console.log("Progress steps updated, saving state...");
                // Note: saveState will be called at the end of the loop anyway
            }
            // --- End Progress Steps Update ---

            // Broadcast full state update periodically or on significant changes
            // For simplicity, let's broadcast essential parts more often
            // const assistantHistoryLength = history.filter(item => item.type === "function_call").length;
            // console.log("Assistant history length:", assistantHistoryLength);
            const lastSummaryText = state.summaries.length > 0 ? state.summaries[state.summaries.length - 1].text : ""; // Get text from the last summary object
            //  Turning the critique OFF also stops replaying the last one. The
            //  file outlives the setting, and the stale critique on disk is
            //  the one asserting "No loops detected" mid-loop -- injecting
            //  that into every prompt is the harm, not generating it.
            const lastCriticism = config.history.selfCritique
                && fsSync.existsSync(config.paths.lastCriticismSaveFile)
                ? fsSync.readFileSync(config.paths.lastCriticismSaveFile, "utf8")
                : "";
            broadcast({
                type: 'full_state', // Or create specific update types
                payload: {
                    current_trainer_data: gameDataJson.current_trainer_data,
                    current_pokemon_data: gameDataJson.current_pokemon_data,
                    inventory_data: gameDataJson.inventory_data,
                    objectives: state.objectives,
                    is_talking_to_npc: gameDataJson.is_talking_to_npc,
                    flash_needed: gameDataJson.flash_needed,
                    flash_active: gameDataJson.flash_active,
                    visibility_reduced: gameDataJson.visibility_reduced,
                    visibility_window_width_tiles: gameDataJson.visibility_window_width_tiles,
                    visibility_window_height_tiles: gameDataJson.visibility_window_height_tiles,
                    memory: state.memory,
                    markers: state.markers,
                    //  DAEMONS: the run's score, and the parts it is made of,
                    //  so the dashboard can show the working rather than a
                    //  bare number nobody can sanity-check.
                    progress: state.progressNow ? {
                        score: state.progressScore,
                        parts: state.progressNow,
                        weights: require("./progress.js").WEIGHTS,
                        delta: require("./progress.js").delta(state.progressNow, state.progressMark),
                    } : null,
                    progressSteps: state.progressSteps,
                    // Use new counter logic for remaining steps
                    remaining_until_criticism: Math.max(0, config.history.limitAssistantMessagesForSelfCriticism - (state.counters.currentStep - state.counters.lastCriticismStep)),
                    remaining_until_summary: Math.max(0, config.history.limitAssistantMessagesForSummary - (state.counters.currentStep - state.counters.lastSummaryStep)),
                    steps: state.counters.currentStep,
                    last_summary: lastSummaryText, // Use the variable derived from the state.summaries array
                    last_criticism: lastCriticism,
                    //  Why the Criticism panel is empty, said out loud. It has been
                    //  blank for days and looked broken every time, because nothing
                    //  on screen distinguished "turned off" from "not working".
                    self_critique_enabled: config.history.selfCritique,
                    //  Both builders, not the one I happened to open first.
                    self_model: Array.isArray(state.selfModel) ? state.selfModel : [],
                    dreams: Array.isArray(state.dreams) ? state.dreams.slice(-8) : [],
                    feelings: state.feelings || null,
                    feeling_events: Array.isArray(state.feelingEvents) ? state.feelingEvents : [],
                    //  So a refreshed dashboard gets the inner voice back.
                    //  Newest last here; the page reverses it for display.
                    asides: Array.isArray(state.asides) ? state.asides.slice(-60) : [],
                    isThinking: state.isThinking,
                    safari_zone_counter: gameDataJson.safari_zone_counter,
                    safari_zone_active: gameDataJson.safari_zone_active,
                }
            });


            // 2. Build vision payload (raw screenshot x3 + optional overlay in overworld)
            const { image1Base64, image2Base64, error: visionError } = await buildVisionPayload(gameDataJson);
            if (!image1Base64) {
                console.error(`Could not build vision payload: ${visionError || "Unknown error"}. Pausing...`);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
                continue;
            }
            // 3. Build the user input for the AI

            // --- Determine if Summary or Criticism is needed ---
            const stepsSinceLastCriticism = state.counters.currentStep - state.counters.lastCriticismStep;
            const stepsSinceLastSummary = state.counters.currentStep - state.counters.lastSummaryStep;
            const shouldSummarizeBasedOnSteps = stepsSinceLastSummary >= config.history.limitAssistantMessagesForSummary;
            const shouldSummarizeBasedOnTokens = state.lastTotalTokens >= config.openai.tokenLimit;
            const shouldSummarize = shouldSummarizeBasedOnSteps || shouldSummarizeBasedOnTokens; // <<< Updated condition


            // Check if the last history item is an EmptyActionError
            //   {
            //     "type": "function_call_output",
            //     "call_id": "call_RwlGoeTRZMoJLzb8C89RpAql",
            //     "output": "Tool call received with no actions to execute, it's forbidden to send an empty action."
            // }

            if (state.history.length > 0) {
                const lastHistoryItem = state.history[state.history.length - 1];
                if (lastHistoryItem.type === "function_call_output" && lastHistoryItem.output === "ERROR: Tool call received with no actions to execute, it's forbidden to send an empty action.") {
                    state.skipNextUserMessage = true;
                }
            }

            if (shouldSummarize) {
                setIsThinking(true);
                console.log(`Triggering summary. Reason: ${shouldSummarizeBasedOnSteps ? 'Steps limit reached' : ''}${shouldSummarizeBasedOnSteps && shouldSummarizeBasedOnTokens ? ' and ' : ''}${shouldSummarizeBasedOnTokens ? 'Token limit reached' : ''}.`); // Add logging
                const summaryPrompt = await fs.readFile(path.join(config.promptsDir, "summary.txt"), "utf8");

                const userInputText = await buildUserInputText(gameDataJson);
                // Broadcast the generated map
                // if (mapDisplayRef) {
                //     broadcast({ type: 'map_update', payload: mapDisplayRef });
                // }
                const newUserMessage = {
                    "role": "user",
                    "content": [
                        // { "type": "input_image", "image_url": `data:image/png;base64,${image1Base64}` },
                        // { "type": "input_image", "image_url": `data:image/png;base64,${image2Base64}` },
                        { "type": "input_text", "text": userInputText },
                        { "type": "input_text", "text": summaryPrompt + "\n\nDo your summary now ! Start your summary with <summary> tags and end it with </summary> tags. You will resume playing after the summary." }
                    ]
                };
                // history.push(newUserMessage);

                const developerPrompt = await buildDeveloperPrompt();
                const processedHistory = processHistoryForAPI(state.history); // Clean old messages
                const apiInput = [developerPrompt, ...processedHistory, newUserMessage];

                // <<< ADDED YIELD >>>
                await new Promise(setImmediate); // Allow event loop before potentially long API call

                // 5. Call the OpenAI API with streaming
                console.log("\n--- Making summary ---");
                // console.log("API Input (history size):", apiInput.length); // Debug

	                const summaryStart = Date.now();
	                const stream = await openai.responses.create({
	                    model: config.openai.model,
	                    service_tier: config.openai.service_tierSummary,
	                    input: apiInput,
	                    text: { format: { type: "text" } },
	                    reasoning: {
	                        effort: config.openai.reasoningEffortSummary,
	                        summary: config.openai.reasoningSummary,
                    },
                    max_output_tokens: config.openai.maxOutputTokens,
                    store: config.openai.store,

                    // store: false, // Important to get call details in the final response,
                    // include: ["reasoning.encrypted_content"],
                    stream: true,
                });

                let finalResponse = null;
                let summaryIsValid = false;
                let newSummaryText = "";
                //  The deltas are already broadcast to the dashboard one by
                //  one; nothing was keeping them.
                let streamedSummaryText = "";
                //  What the stream ACTUALLY sent.
                //
                //  A summary failed three times against or-muse-glimmer and
                //  logged nothing at all -- not the character counts below,
                //  which means `response.completed` never arrived and the
                //  `else` that reports the counts never ran. Three model calls
                //  produced no evidence of what they returned. Recording the
                //  event types costs one array and turns the next failure into
                //  a fact instead of a guess.
                const summaryEventTypes = [];
                try {

                    for await (const event of stream) {
                        summaryEventTypes.push(event.type);
                        switch (event.type) {
                            case "response.output_item.added":
                                if (event.item.type === "reasoning") console.log("\n=== Reasoning ===");
                                if (event.item.type === "message") {
                                    console.log("\n=== Text Response ===");
                                    broadcast({ type: 'summary_start', payload: 'Starting history summary...' });
                                }
                                if (event.item.type === "function_call") console.log("\n=== Tool Call ===");
                                break;
                            case "response.reasoning_summary_part.done":
                                broadcast({ type: 'reasoning_chunk', payload: "\n\n" }); // <<< Broadcast reasoning chunk
                                process.stdout.write("\n\n");
                                break;
                            case "response.output_item.done":
                                if (event.item.type === "reasoning" || event.item.type === "output_text") {
                                    console.log("--------------------");
                                }
                                break;
                            case "response.reasoning_summary_text.delta":
                                process.stdout.write(event.delta);
                                broadcast({ type: 'reasoning_chunk', payload: event.delta }); // <<< Broadcast reasoning chunk
                                break;
                            case "response.output_text.delta":
                                process.stdout.write(event.delta);
                                streamedSummaryText += event.delta;
                                broadcast({ type: 'summary_chunk', payload: event.delta }); // <<< Broadcast summary chunk
                                break;
                            case "response.completed":
                                responseCompleted = true;
                                console.log("\n=== End of model response ===");
                                console.log("Usage Tokens:", JSON.stringify(event.response.usage, null, 2));
                                finalResponse = event.response; // Store the final response
                                const summaryDuration = Date.now() - summaryStart;
	                                recordReasoning({
	                                    type: "summary",
	                                    model: config.openai.model,
	                                    serviceTier: config.openai.service_tierSummary,
	                                    durationMs: summaryDuration,
	                                });
	                                // <<< Calculate and log cost >>>
	                                const summaryCost = calculateRequestCost(event.response.usage, config.openai.model, config.openai.tokenPrice, config.openai.service_tierSummary);
	                                if (summaryCost !== null) {
	                                    console.log(`Estimated Cost: $${summaryCost.fullCost} (Discounted: $${summaryCost.discountedCost})`);
	                                    broadcast({ type: 'token_usage', payload: { ...event.response.usage, cost: summaryCost.fullCost, discountedCost: summaryCost.discountedCost } }); // Include cost
	                                    recordLoopUsage({ callType: "summary", usage: event.response.usage, cost: summaryCost, model: config.openai.model, serviceTier: config.openai.service_tierSummary });
	                                } else {
	                                    broadcast({ type: 'token_usage', payload: event.response.usage }); // Broadcast usage even if cost fails
	                                    recordLoopUsage({ callType: "summary", usage: event.response.usage, cost: null, model: config.openai.model, serviceTier: config.openai.service_tierSummary });
	                                }
	                                // console.log(JSON.stringify(event.response.output, null, 2)); // Less verbose
	                                // Extract summary text (do not persist yet; we may roll it up before saving)
                                const summaryItem = (event.response.output || []).find(item => item.type === "message");
                                const structuredText = summaryItem?.content?.find(item => item.type === "output_text")?.text || "";
                                //  `event.response.output` is the field that comes back EMPTY
                                //  through LiteLLM's /responses bridge -- the same emptiness that
                                //  once blinded the loop guard to 118 of 119 calls. The text we
                                //  watched stream past is the fallback.
                                newSummaryText = structuredText || streamedSummaryText;
                                //  The <summary> tags are a formatting request, not the summary.
                                //  Requiring them discarded good prose because a model closed with
                                //  </Summary> or omitted the wrapper -- and the retry that followed
                                //  could never fix it, since nothing about the next attempt was
                                //  different. Strip the tags where they exist; judge what is left.
                                newSummaryText = newSummaryText.replace(/<\/?summary>/gi, "").trim();
                                if (newSummaryText.length >= 40) {
                                    summaryIsValid = true;
                                } else {
                                    console.warn(`Summary came back with ${newSummaryText.length} usable characters (structured item: ${structuredText ? "present" : "ABSENT"}, streamed: ${streamedSummaryText.length} chars).`);
                                }

                                broadcast({ type: 'summary_end', payload: 'History summary finished.' });
                                break;
                            case "error":
                                console.error("\n--- model stream error ---");
                                console.error(event.error);
                                if (!responseCompleted) {
                                    broadcast({ type: 'error_message', payload: `OpenAI Stream Error: ${event.error?.message || 'Unknown error'}` }); // <<< Broadcast API error
                                    throw new Error(`OpenAI Stream Error: ${event.error?.message || 'Unknown error'}`); // Stop in case of API error
                                }
                            default:
                                // console.log("Unknown event type:", event.type);
                                break;
                            // Add other cases if necessary (e.g., response.input_processed)
                        }
                    }
                } catch (streamError) {
                    if (!responseCompleted) {
                        console.error("\n--- model stream processing error ---");
                        console.error(streamError);
                        broadcast({ type: 'error_message', payload: `OpenAI Stream Processing Error: ${streamError?.message || 'Unknown error'}` });
                        throw streamError; // Re-throw if we didn't complete successfully
                    } else {
                        console.warn("Stream processing error occurred after response completion - ignoring and removing reasoning fields:", streamError?.message);

                        // Remove reasoning fields from the response output
                        if (finalResponse?.output && Array.isArray(finalResponse.output)) {
                            finalResponse.output = finalResponse.output.filter(item => item.type !== "reasoning");
                        }

                        // Remove all the "id" fields from the response output
                        if (finalResponse?.output && Array.isArray(finalResponse.output)) {
                            finalResponse.output = finalResponse.output.map(item => {
                                if (item.id) delete item.id;
                                return item;
                            });
                        }
                    }
                }

                if (!summaryIsValid) {
                    //  Say what the stream sent. Counted, not listed: a summary
                    //  stream is thousands of deltas and printing them all would
                    //  bury the one line that matters.
                    const seen = summaryEventTypes.reduce((acc, t) => {
                        acc[t] = (acc[t] || 0) + 1;
                        return acc;
                    }, {});
                    console.warn(
                        `  summary stream sent ${summaryEventTypes.length} events: `
                        + (Object.keys(seen).length
                            ? Object.entries(seen).map(([t, n]) => `${t} x${n}`).join(", ")
                            : "NONE -- the stream was empty")
                        + `; response.completed ${seen["response.completed"] ? "arrived" : "NEVER ARRIVED"}`
                    );
                    summaryAttempts += 1;
                    //  Three tries, then take the step regardless. An unbounded
                    //  retry is worse than a missing summary: it halts the game
                    //  as surely as a crash, while saying only "trying again".
                    if (summaryAttempts >= 3) {
                        //  SKIPPING THE SUMMARY IS NOT ENOUGH, and the first
                        //  version of this escape hatch got that wrong.
                        //
                        //  Summarising is the ONLY thing that folds the
                        //  history -- a successful summary replaces the whole
                        //  array. Skipping it resumed play while leaving the
                        //  very condition that made the summary necessary, so
                        //  the history kept growing: measured at 489 items and
                        //  12.4 MB, ~124k tokens per call and climbing, until
                        //  a call simply stopped coming back. That is slower
                        //  and less honest than the infinite retry it replaced,
                        //  which at least stalled visibly.
                        //
                        //  So if the model cannot fold it, fold it mechanically.
                        //  Losing old context is a real cost; an unbounded
                        //  prompt is a stalled run.
                        const before = state.history.length;
                        const KEEP = 40;
                        if (before > KEEP) {
                            const backupFolder = "backup";
                            if (!fsSync.existsSync(backupFolder)) fsSync.mkdirSync(backupFolder, { recursive: true });
                            fsSync.writeFileSync(
                                path.join(backupFolder, `history_unfolded_${Date.now()}.json`),
                                JSON.stringify(state.history, null, 2)
                            );
                            //  A function_call_output with no function_call
                            //  above it is a 400 from the API, so the cut
                            //  cannot land between a call and its result.
                            //  Walk forward to the first item that can legally
                            //  open a history.
                            let cut = before - KEEP;
                            while (cut < before && state.history[cut].type === "function_call_output") cut += 1;
                            state.history = state.history.slice(cut);
                            state.history.unshift({
                                role: "user",
                                content: [{ type: "input_text", text:
                                    "<system>Earlier history was trimmed to keep the context workable. "
                                    + "Your objectives and memory are intact and authoritative -- read them "
                                    + "rather than relying on recall.</system>" }],
                            });
                            console.warn(`Summary failed ${summaryAttempts} times; TRIMMED history ${before} -> ${state.history.length} items mechanically. Old history saved to backup/.`);
                        } else {
                            console.warn(`Summary failed ${summaryAttempts} times; history is only ${before} items, leaving it alone.`);
                        }
                        broadcast({ type: 'summary_end', payload: `Summary failed; history trimmed ${before} -> ${state.history.length}.` });
                        summaryAttempts = 0;
                        state.counters.lastSummaryStep = state.counters.currentStep;
                        state.counters.lastCriticismStep = state.counters.currentStep;
                        state.lastTotalTokens = 0;
                        await savePersistentState();
                    } else {
                        console.log(`Summary is not valid (attempt ${summaryAttempts}/3), trying again...`);
                    }
                    continue;
                }
                summaryAttempts = 0;

                // Persist summary (and rollup if we reached the threshold) BEFORE saving summaries.json / rewriting history.json.
                const summaryTimestamp = new Date().toISOString();
                const baseSummaryEntry = {
                    text: newSummaryText,
                    step: state.counters.currentStep,
                    timestamp: summaryTimestamp,
                };

                const existingAllSummaries = Array.isArray(state.allSummaries) ? state.allSummaries : [];
                const existingSummaries = Array.isArray(state.summaries) ? state.summaries : [];

                const nextAllSummaries = [...existingAllSummaries, { ...baseSummaryEntry, kind: "summary" }];
                const nextSummaries = [...existingSummaries, baseSummaryEntry];

                let finalSummaries = nextSummaries;
                let rolledUpText = null;

                if (nextSummaries.length >= 10) {
                    console.log(`Summaries reached ${nextSummaries.length}; running summary rollup...`);
                    broadcast({ type: 'summary_rollup_start', payload: { count: nextSummaries.length } });

                    try {
                        const rollupPrompt = await fs.readFile(path.join(config.promptsDir, "summary_rollup.txt"), "utf8");
                        const rollupInputText =
                            rollupPrompt +
                            "\n\n" +
                            nextSummaries
                                .map(
                                    (s, i) =>
                                        `=== SUMMARY ${i + 1}/${nextSummaries.length} ===\n${s.text}`
                                )
                                .join("\n\n");

                        const rollupStart = Date.now();
                        const rollupStream = await openai.responses.create({
                            model: config.openai.model,
                            service_tier: config.openai.service_tierSummary,
                            input: [
                                {
                                    role: "user",
                                    content: [{ type: "input_text", text: rollupInputText }],
                                },
                            ],
                            text: { format: { type: "text" } },
                            reasoning: {
                                effort: "xhigh",
                                summary: config.openai.reasoningSummary,
                            },
                            max_output_tokens: 64000,
                            store: config.openai.store,
                            stream: true,
                        });
                        let rollupResponseCompleted = false;
                        let rollupFinalResponse = null;

                        let rollupTextAccum = "";
                        try {
                            for await (const event of rollupStream) {
                                switch (event.type) {
                                    case "response.output_item.added":
                                        if (event.item.type === "reasoning") console.log("\n=== Rollup Reasoning ===");
                                        if (event.item.type === "message") {
                                            console.log("\n=== Rollup Text Response ===");
                                            // Reuse summary broadcast keys so the frontend can render live.
                                            broadcast({ type: 'summary_start', payload: 'Starting summary rollup...' });
                                        }
                                        break;
                                    case "response.reasoning_summary_part.done":
                                        broadcast({ type: 'reasoning_chunk', payload: "\n\n" });
                                        process.stdout.write("\n\n");
                                        break;
                                    case "response.reasoning_summary_text.delta":
                                        process.stdout.write(event.delta);
                                        broadcast({ type: 'reasoning_chunk', payload: event.delta });
                                        break;
                                    case "response.output_text.delta":
                                        process.stdout.write(event.delta);
                                        rollupTextAccum += event.delta;
                                        broadcast({ type: 'summary_chunk', payload: event.delta });
                                        break;
                                    case "response.output_item.done":
                                        if (event.item.type === "reasoning" || event.item.type === "output_text") {
                                            console.log("--------------------");
                                        }
                                        break;
                                    case "response.completed":
                                        rollupResponseCompleted = true;
                                        rollupFinalResponse = event.response;
                                        console.log("\n=== End of Rollup Response ===");
                                        console.log("Rollup Usage Tokens:", JSON.stringify(event.response.usage, null, 2));

                                        {
                                            const rollupDuration = Date.now() - rollupStart;
                                            recordReasoning({
                                                type: "summary_rollup",
                                                model: config.openai.model,
                                                serviceTier: config.openai.service_tierSummary,
                                                durationMs: rollupDuration,
                                            });

                                            const rollupCost = calculateRequestCost(
                                                event.response.usage,
                                                config.openai.model,
                                                config.openai.tokenPrice,
                                                config.openai.service_tierSummary
                                            );
                                            if (rollupCost !== null) {
                                                console.log(
                                                    `Estimated Rollup Cost: $${rollupCost.fullCost} (Discounted: $${rollupCost.discountedCost})`
                                                );
                                                broadcast({
                                                    type: 'token_usage',
                                                    payload: { ...event.response.usage, cost: rollupCost.fullCost, discountedCost: rollupCost.discountedCost },
                                                });
                                                recordLoopUsage({
                                                    callType: "summary_rollup",
                                                    usage: event.response.usage,
                                                    cost: rollupCost,
                                                    model: config.openai.model,
                                                    serviceTier: config.openai.service_tierSummary,
                                                });
                                            } else {
                                                broadcast({ type: 'token_usage', payload: event.response.usage });
                                                recordLoopUsage({
                                                    callType: "summary_rollup",
                                                    usage: event.response.usage,
                                                    cost: null,
                                                    model: config.openai.model,
                                                    serviceTier: config.openai.service_tierSummary,
                                                });
                                            }
                                        }

                                        broadcast({ type: 'summary_end', payload: 'Summary rollup finished.' });
                                        break;
                                    case "error":
                                        console.error("\n--- Rollup Stream Error ---");
                                        console.error(event.error);
                                        if (!rollupResponseCompleted) {
                                            broadcast({
                                                type: 'error_message',
                                                payload: `OpenAI Rollup Stream Error: ${event.error?.message || 'Unknown error'}`,
                                            });
                                            throw new Error(
                                                `OpenAI Rollup Stream Error: ${event.error?.message || 'Unknown error'}`
                                            );
                                        }
                                    default:
                                        break;
                                }
                            }
                        } catch (rollupStreamError) {
                            if (!rollupResponseCompleted) {
                                console.error("\n--- Rollup Stream Processing Error ---");
                                console.error(rollupStreamError);
                                broadcast({
                                    type: 'error_message',
                                    payload: `OpenAI Rollup Stream Processing Error: ${rollupStreamError?.message || 'Unknown error'}`,
                                });
                                throw rollupStreamError;
                            } else {
                                console.warn(
                                    "Rollup stream error occurred after completion - ignoring:",
                                    rollupStreamError?.message
                                );
                            }
                        }

                        if (!rollupFinalResponse) {
                            throw new Error("No final rollup response received from the OpenAI API after the stream.");
                        }

                        const rollupMessage = Array.isArray(rollupFinalResponse.output)
                            ? rollupFinalResponse.output.find((item) => item.type === "message")
                            : null;
                        const rollupText =
                            rollupMessage?.content?.find((item) => item.type === "output_text")?.text || rollupTextAccum;

                        if (rollupText.includes("<summary>") && rollupText.includes("</summary>")) {
                            rolledUpText = rollupText;

                            const rollupTimestamp = new Date().toISOString();
                            const rollupEntry = {
                                text: rolledUpText,
                                step: state.counters.currentStep,
                                timestamp: rollupTimestamp,
                            };

                            nextAllSummaries.push({
                                ...rollupEntry,
                                kind: "rollup",
                                sourceCount: nextSummaries.length,
                            });
                            finalSummaries = [rollupEntry];

                            // Replace the summary content that will be written into history.json.
                            if (finalResponse?.output && Array.isArray(finalResponse.output)) {
                                const msgItem = finalResponse.output.find((item) => item.type === "message");
                                const outTextItem = msgItem?.content?.find((c) => c.type === "output_text");
                                if (outTextItem) outTextItem.text = rolledUpText;
                            }

                            console.log("Summary rollup succeeded; compacting summaries to a single rolled-up entry.");
                        } else {
                            console.warn("Summary rollup produced invalid output; keeping original summary and full summaries list.");
                        }
                    } catch (rollupError) {
                        console.error("Summary rollup failed; keeping original summary and full summaries list:", rollupError);
                    } finally {
                        broadcast({ type: 'summary_rollup_end', payload: { ok: Boolean(rolledUpText) } });
                    }
                }

                state.allSummaries = nextAllSummaries;
                state.summaries = finalSummaries;
                console.log(
                    `Summary stored. summaries=${state.summaries.length}, allSummaries=${state.allSummaries.length}`
                );
                state.lastTotalTokens = 0;

                // TODO: Save the old history in a backup folder and replace the whole history with the summary
                const backupFolder = "backup";
                if (!fsSync.existsSync(backupFolder)) {
                    fsSync.mkdirSync(backupFolder, { recursive: true });
                }
                const backupFile = path.join(backupFolder, `history_backup_${Date.now()}.json`);
                fsSync.writeFileSync(backupFile, JSON.stringify(state.history, null, 2));

                // Replace the whole history with the summary
                state.history = [];
                // Always include the last summary in the history, to have more context
                // We keep the last summary in the history + the new summary
                // if (lastSummary) {
                //     history.push({
                //         "role": "assistant",
                //         "content": [{ "type": "output_text", "text": lastSummary }]
                //     });
                // }
                // Get the last 2 state.summaries before the current one
                const lastTwoSummaries = state.summaries.slice(0, -1).slice(-2);

                console.log(`Adding ${lastTwoSummaries.length} last state.summaries to history.`);

                // // Add the last 2 state.summaries to history
                // lastTwoSummaries.forEach(summary => {
                //     state.history.push({
                //         "role": "assistant",
                //         "content": [{ "type": "output_text", "text": summary.text }]
                //     });
                // });

                if (finalResponse?.output) {
                    finalResponse.output.forEach(item => {
                        state.history.push(item); // Add the item (potentially modified) to the history
                    });
                }

                // Add a user message to the history to remind the AI to play the game
                state.history.push({
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "<system>Resume your gameplay now !</system>" }
                    ]
                });
                state.skipNextUserMessage = true;

                //  THE DREAM. Same boundary as the fold, because it is made of
                //  what the fold discards -- one short call, no tools, and a
                //  failure here must never cost the summary that just worked.
                try {
                    const dream = require("./dream.js");
                    const dreamRes = await openai.responses.create({
                        model: config.openai.model,
                        input: [{ role: "user", content: [{ type: "input_text",
                            text: dream.buildDreamPrompt(newSummaryText, state.selfModel, state.asides) }] }],
                        text: { format: { type: "text" } },
                        reasoning: { effort: "low", summary: config.openai.reasoningSummary },
                        max_output_tokens: 2000,
                        store: config.openai.store,
                        stream: false,
                    });
                    const item = (dreamRes?.output || []).find((o) => o.type === "message");
                    const text = item?.content?.find((c) => c.type === "output_text")?.text
                        || dreamRes?.output_text || "";
                    const entry = dream.record(state, text);
                    if (entry) {
                        console.log(`\n=== Dream ===\n${entry.text}\n`);
                        broadcast({ type: 'dream', payload: entry });
                    } else {
                        console.warn("Dream call returned nothing usable; skipping.");
                    }
                } catch (e) {
                    console.warn(`Dream failed (${e?.message || e}); the summary stands.`);
                }

                state.counters.lastSummaryStep = state.counters.currentStep; // Update last summary step
                // Update also the lastCriticismStep
                state.counters.lastCriticismStep = state.counters.currentStep;
                // REMOVED: selfCriticismDone = false;
                // Save the new history and state.counters
                await savePersistentState();
                continue; // Skip the rest of the loop for summary turn

            } else if (!state.skipNextUserMessage) { // <<< Check the flag BEFORE creating newUserMessage
                const userInputText = await buildUserInputText(gameDataJson);
                const lastHistoryItem = state.history.length > 0 ? state.history[state.history.length - 1] : null;
                // DAEMONS: appending image/text items INTO a function_call_output
                // makes its `output` an ARRAY. api.openai.com accepts that;
                // LiteLLM's /responses -> /chat/completions bridge does not,
                // and rejects the whole request with
                //     400 Invalid type for 'input'  (code invalid_union)
                // which names `input` and never mentions the tool output that
                // caused it. Verified directly against the proxy: identical
                // request with a STRING output passes, with a LIST fails.
                //
                // The else branch below builds the same images and the same
                // text as an ordinary user message, so taking it costs nothing
                // -- the model sees exactly what it would have seen.
                //
                // Set DAEMONS_EXTEND_TOOL_OUTPUT=1 to restore the original
                // behaviour when talking to an endpoint that supports it.
                const allowArrayToolOutput = process.env.DAEMONS_EXTEND_TOOL_OUTPUT === "1";
                const canExtendLastToolOutput = allowArrayToolOutput
                    && lastHistoryItem?.type === "function_call_output"
                    && Array.isArray(lastHistoryItem.output);
                // console.log("User input text:", userInputText);
                // Broadcast the generated map
                // if (mapDisplayRef) {
                //     broadcast({ type: 'map_update', payload: mapDisplayRef });
                // }

                if (canExtendLastToolOutput) {
                    const appendedOutputItems = [];

                    appendedOutputItems.push({ "type": "input_image", "image_url": `data:image/png;base64,${image1Base64}` });
                    if (image2Base64) {
                        appendedOutputItems.push({ "type": "input_image", "image_url": `data:image/png;base64,${image2Base64}` });
                    }
                    appendedOutputItems.push({ "type": "input_text", "text": userInputText });

                    lastHistoryItem.output.push(...appendedOutputItems);
                    console.log("Appended inputs to last function_call_output entry.");
                } else {
                    // Broadcast the generated map
                    // if (mapDisplayRef) {
                    //     broadcast({ type: 'map_update', payload: mapDisplayRef });
                    // }
                    const content = [{ "type": "input_image", "image_url": `data:image/png;base64,${image1Base64}` }];
                    if (image2Base64) {
                        content.push({ "type": "input_image", "image_url": `data:image/png;base64,${image2Base64}` });
                    }
                    content.push({ "type": "input_text", "text": userInputText });
                    newUserMessage = { "role": "user", "content": content };
                    console.log("Created newUserMessage for this step.");
                }
            } else {
                newUserMessage = null; // Ensure it's null if skipped
                console.log("Skipping creation of newUserMessage due to skipNextUserMessage flag.");
            }
            setIsThinking(true);

            // 4. Prepare the complete input for the OpenAI API
            const developerPrompt = await buildDeveloperPrompt();
            const processedHistory = processHistoryForAPI(newUserMessage ? [...state.history, newUserMessage] : state.history); // Clean old messages
            const apiInput = [developerPrompt, ...processedHistory].map((item) => {
                // DAEMONS: normalise at the boundary. A function_call_output
                // whose `output` is an ARRAY is rejected by LiteLLM's
                // /responses -> /chat/completions bridge with a flat
                //     400 Invalid type for 'input'   (code: invalid_union)
                // that names the whole array and not the offending member.
                //
                // The four construction sites in tools.js already emit strings
                // (see toolOutput there), and handleToolCall was verified
                // returning a string -- yet arrays still reached the wire, and
                // reading every path between the two did not explain it. So
                // this coerces here, where the request is actually assembled:
                // whatever produced the array, it cannot leave this function.
                //
                // Lossless for our case: every such output is a single
                // input_text, and images take the user-message path.
                if (item && item.type === "function_call_output" && Array.isArray(item.output)) {
                    const text = item.output
                        .filter((x) => x && x.type === "input_text")
                        .map((x) => x.text)
                        .join("\n");
                    return { ...item, output: text };
                }
                return item;
            });

            // DAEMONS: dump the exact request that goes on the wire, so a 400
            // naming only `input` can be bisected instead of guessed at. Three
            // guesses cost a day; the file costs nothing.
            if (process.env.DAEMONS_DUMP_INPUT) {
                try {
                    require("fs").writeFileSync(
                        process.env.DAEMONS_DUMP_INPUT,
                        JSON.stringify(apiInput, null, 1));
                } catch (e) { /* never let debugging break the run */ }
            }
            const tools = defineTools();

            // 5. Call the OpenAI API with streaming
            console.log(`\n--- Sending to ${config.openai.model} ---`);
            // console.log("API Input (history size):", apiInput.length); // Debug


            // Only criticize if enough steps have passed AND we are not summarizing this turn
            //  DAEMONS: self-critique is off by default for local models,
            //  because the critique it produced was confidently false.
            //
            //  Verbatim, from a run that had spent the previous hour pressing
            //  `left` into the same wall from the same tile:
            //
            //    "## Loop Analysis
            //     No loops detected; the player is systematically exploring
            //     and placing markers, moving toward objective completion
            //     without repeating ineffective paths."
            //
            //  It also assessed battle conduct ("supports the objective of
            //  defeating trainers") in a run that has never had a battle, and
            //  then recommended writing that up as a tips_ memory entry.
            //
            //  It is not merely a wasted call. Its output is saved and
            //  injected as <last_criticism> into every prompt until the next
            //  one, so a wrong reading contaminates the following 55 steps --
            //  and "no loops detected" is the exact opposite of the thing the
            //  run most needed to notice.
            //
            //  DAEMONS_SELF_CRITIQUE=1 restores it for a model that can do it.
            //  BACK ON by default, 2026-09-08. It was turned off because it
            //  wrote "no loops detected" during an hour of walking into the
            //  same wall -- on ternary-bonsai-8b, and asked to spot a loop
            //  while being shown a single screen. Both halves are now fixed:
            //  it gets a measured trajectory (trajectory.js), and its output
            //  is framed to the agent as a hypothesis rather than a finding.
            //  DAEMONS_SELF_CRITIQUE=0 turns it off again.
            const critiqueEnabled = config.history.selfCritique;
            const shouldCriticize = critiqueEnabled
                && stepsSinceLastCriticism >= config.history.limitAssistantMessagesForSelfCriticism;
            if (shouldCriticize) { // Use the pre-calculated flag and remove assistantHistoryLength check
                const selfCriticismPrompt = await fs.readFile(path.join(config.promptsDir, "self_criticism.txt"), "utf8");
                //  Hand it the trajectory. The framework asks it to detect
                //  loops and, until now, gave it only the current state -- one
                //  position, one screen. A loop is a property of a path, so it
                //  was being asked to see something absent from its input, and
                //  it answered "no loops detected" mid-loop. Counts, not a
                //  verdict: the digest reports and the model decides.
                const trajectory = require("./trajectory.js").digest(state.history, { limit: 40 });
                if (trajectory) console.log(`  trajectory digest:\n${trajectory.split("\n").map(l => "    " + l).join("\n")}`);
                const newUserMessage = {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": selfCriticismPrompt
                            + (trajectory
                                ? "\n\n---\n\n# WHAT ACTUALLY HAPPENED\n\n"
                                  + "Measured from your own history rather than recalled. Use it "
                                  + "for the loop section especially -- you cannot detect a loop "
                                  + "from a single screen, and this is the part you could not see.\n\n"
                                  + trajectory
                                : "") }
                    ]
                };
                // history.push(newUserMessage);

                const apiInputCriticism = [...apiInput, newUserMessage];

                // <<< ADDED YIELD >>>
                await new Promise(setImmediate); // Allow event loop before potentially long API call

                // 5. Call the OpenAI API with streaming
                console.log("\n--- Making self-criticism ---");
                // console.log("API Input (history size):", apiInput.length); // Debug

	                const criticismStart = Date.now();
	                const stream = await openai.responses.create({
	                    model: config.openai.model,
	                    service_tier: config.openai.service_tierSelfCriticism,
	                    input: apiInputCriticism,
	                    text: { format: { type: "text" } },
	                    reasoning: {
	                        effort: config.openai.reasoningEffortCriticism,
	                        summary: config.openai.reasoningSummary,
                    },
                    max_output_tokens: config.openai.maxOutputTokens,
                    store: config.openai.store,
                    // store: false, // Important to get call details in the final response,
                    // include: ["reasoning.encrypted_content"],
                    stream: true,
                });

                let finalResponse = null;
                try {

                    for await (const event of stream) {
                        switch (event.type) {
                            case "response.output_item.added":
                                if (event.item.type === "reasoning") {
                                    console.log("\n=== Reasoning ===");
                                }
                                if (event.item.type === "message") {
                                    console.log("\n=== Text Response ===");
                                    broadcast({ type: 'criticism_start', payload: 'Starting self-criticism...' });
                                }
                                if (event.item.type === "function_call") console.log("\n=== Tool Call ===");
                                break;
                            case "response.reasoning_summary_part.done":
                                broadcast({ type: 'reasoning_chunk', payload: "\n\n" }); // <<< Broadcast reasoning chunk
                                process.stdout.write("\n\n");
                                break;
                            case "response.output_item.done":
                                if (event.item.type === "reasoning" || event.item.type === "output_text") {
                                    console.log("--------------------");
                                }
                                break;
                            case "response.reasoning_summary_text.delta":
                                process.stdout.write(event.delta);
                                broadcast({ type: 'reasoning_chunk', payload: event.delta }); // <<< Broadcast reasoning chunk
                                break;
                            case "response.output_text.delta":
                                process.stdout.write(event.delta);
                                broadcast({ type: 'criticism_chunk', payload: event.delta }); // <<< Broadcast criticism chunk
                                break;
                            case "response.completed":
                                responseCompleted = true;
                                console.log("\n=== End of model response ===");
                                console.log("Usage Tokens:", JSON.stringify(event.response.usage, null, 2));
                                finalResponse = event.response; // Store the final response
                                const criticismDuration = Date.now() - criticismStart;
	                                recordReasoning({
	                                    type: "self_criticism",
	                                    model: config.openai.model,
	                                    serviceTier: config.openai.service_tierSelfCriticism,
	                                    durationMs: criticismDuration,
	                                });
	                                // <<< Calculate and log cost >>>
	                                const criticismCost = calculateRequestCost(event.response.usage, config.openai.model, config.openai.tokenPrice, config.openai.service_tierSelfCriticism);
	                                if (criticismCost !== null) {
	                                    console.log(`Estimated Cost: $${criticismCost.fullCost} (Discounted: $${criticismCost.discountedCost})`);
	                                    broadcast({ type: 'token_usage', payload: { ...event.response.usage, cost: criticismCost.fullCost, discountedCost: criticismCost.discountedCost } }); // Include cost
	                                    recordLoopUsage({ callType: "self_criticism", usage: event.response.usage, cost: criticismCost, model: config.openai.model, serviceTier: config.openai.service_tierSelfCriticism });
	                                } else {
	                                    broadcast({ type: 'token_usage', payload: event.response.usage }); // Broadcast usage even if cost fails
	                                    recordLoopUsage({ callType: "self_criticism", usage: event.response.usage, cost: null, model: config.openai.model, serviceTier: config.openai.service_tierSelfCriticism });
	                                }
	                                // console.log(JSON.stringify(event.response.output, null, 2)); // Less verbose
	                                // Save the criticism to the text file "last_criticism.txt"
	                                const criticismItem = event.response.output.find(item => item.type === "message");
	                                const criticismText = criticismItem?.content?.find(item => item.type === "output_text")?.text || "[Criticism Error]";
                                fsSync.writeFileSync(config.paths.lastCriticismSaveFile, criticismText);
                                broadcast({ type: 'criticism_end', payload: 'Self-criticism finished.' });
                                break;
                            case "error":
                                console.error("\n--- model stream error ---");
                                console.error(event.error);
                                if (!responseCompleted) {
                                    broadcast({ type: 'error_message', payload: `OpenAI Stream Error: ${event.error?.message || 'Unknown error'}` }); // <<< Broadcast API error
                                    throw new Error(`OpenAI Stream Error: ${event.error?.message || 'Unknown error'}`); // Stop in case of API error
                                }
                            default:
                                // console.log("Unknown event type:", event.type);
                                console.log("Event:", JSON.stringify(event, null, 2));
                                break;
                            // Add other cases if necessary (e.g., response.input_processed)
                        }
                    }
                } catch (streamError) {
                    if (!responseCompleted) {
                        console.error("\n--- model stream processing error ---");
                        console.error(streamError);
                        broadcast({ type: 'error_message', payload: `OpenAI Stream Processing Error: ${streamError?.message || 'Unknown error'}` });
                        throw streamError; // Re-throw if we didn't complete successfully
                    } else {
                        console.warn("Stream processing error occurred after response completion - ignoring and removing reasoning fields:", streamError?.message);
                        // Remove reasoning fields from the response output
                        if (finalResponse?.output && Array.isArray(finalResponse.output)) {
                            finalResponse.output = finalResponse.output.filter(item => item.type !== "reasoning");
                        }

                        // Remove all the "id" fields from the response output
                        if (finalResponse?.output && Array.isArray(finalResponse.output)) {
                            finalResponse.output = finalResponse.output.map(item => {
                                if (item.id) delete item.id;
                                return item;
                            });
                        }
                    }
                }

                if (finalResponse?.output) {
                    finalResponse.output.forEach(item => {
                        state.history.push(item); // Add the item (potentially modified) to the history
                        apiInput.push(item);
                    });
                }

                // Save the new history
                state.counters.lastCriticismStep = state.counters.currentStep; // Update last criticism step
                state.selfCritiqueReminderPending = true; // Flag reminder for the next actionable step
                await savePersistentState();
                continue; // Skip the rest of the loop for criticism turn
            }


            let reasoningEffort = config.openai.reasoningEffort;
            if (gameDataJson.is_talking_to_npc) {
                reasoningEffort = config.openai.reasoningEffortDialog;
            }
            if (gameDataJson.battle_data?.in_battle) {
                reasoningEffort = config.openai.reasoningEffortBattle;
            }
            console.log("reasoningEffort:", reasoningEffort);
            const mainCallStart = Date.now();
            const stream = await openai.responses.create({
                model: config.openai.model,
                service_tier: config.openai.service_tier,
                input: apiInput,
                text: { format: { type: "text" } },
                reasoning: {
                    effort: reasoningEffort,
                    summary: config.openai.reasoningSummary,
                },
                tools: tools,
                tool_choice: "required",
                parallel_tool_calls: false,
                max_output_tokens: config.openai.maxOutputTokens,
                store: config.openai.store,
                // store: false, // Important to get call details in the final response,
                // include: ["reasoning.encrypted_content"],
                stream: true,
            });

            // 6. Process the streamed response
            let currentReasoning = "";
            let currentOutputText = "";
            let finalResponse = null; // Reset finalResponse for the new call
            try {

                for await (const event of stream) {
                    switch (event.type) {
                        case "response.output_item.added":
                            if (event.item.type === "reasoning") console.log("\n=== Reasoning ===");
                            if (event.item.type === "message") console.log("\n=== Text Response ===");
                            if (event.item.type === "function_call") console.log("\n=== Tool Call ===");
                            break;
                        case "response.reasoning_summary_part.done":
                            broadcast({ type: 'reasoning_chunk', payload: "\n\n" }); // <<< Broadcast reasoning chunk
                            process.stdout.write("\n\n");
                            break;
                        case "response.output_item.done":
                            if (event.item.type === "reasoning" || event.item.type === "output_text") {
                                console.log("--------------------");
                            }
                            break;
                        case "response.reasoning_summary_text.delta":
                            process.stdout.write(event.delta);
                            currentReasoning += event.delta;
                            broadcast({ type: 'reasoning_chunk', payload: event.delta }); // <<< Broadcast reasoning chunk
                            break;
                        case "response.output_text.delta":
                            process.stdout.write(event.delta);
                            broadcast({ type: 'reasoning_chunk', payload: event.delta }); // <<< Broadcast reasoning chunk
                            currentOutputText += event.delta;
                            break;
                        case "response.completed":
                            responseCompleted = true;
                            console.log("\n=== End of model response ===");
                            console.log("Usage Tokens:", JSON.stringify(event.response.usage, null, 2));
                            finalResponse = event.response; // Store the final response
                            const mainDuration = Date.now() - mainCallStart;
                            recordReasoning({
                                type: "main",
                                model: config.openai.model,
                                serviceTier: config.openai.service_tier,
                                durationMs: mainDuration,
                            });
                            // <<< Calculate and log cost >>>
                            const requestCost = calculateRequestCost(event.response.usage, config.openai.model, config.openai.tokenPrice, config.openai.service_tier);
                            if (requestCost !== null) {
                                console.log(`Estimated Cost: $${requestCost.fullCost} (Discounted: $${requestCost.discountedCost})`);
                                broadcast({ type: 'token_usage', payload: { ...event.response.usage, cost: requestCost.fullCost, discountedCost: requestCost.discountedCost } }); // Include cost
                                recordLoopUsage({ callType: "main", usage: event.response.usage, cost: requestCost, model: config.openai.model, serviceTier: config.openai.service_tier });
                            } else {
                                broadcast({ type: 'token_usage', payload: event.response.usage }); // Broadcast usage even if cost fails
                                recordLoopUsage({ callType: "main", usage: event.response.usage, cost: null, model: config.openai.model, serviceTier: config.openai.service_tier });
                            }
                            broadcast({ type: 'reasoning_end', payload: null }); // <<< Signal end of reasoning stream
                            if (event.response.usage?.total_tokens) {
                                state.lastTotalTokens = event.response.usage.total_tokens; // <<< Update lastTotalTokens
                                console.log(`Updated lastTotalTokens: ${state.lastTotalTokens}`); // Add logging
                            } else {
                                console.warn("Could not read total_tokens from API response usage.");
                            }
                            break;
                        case "error":
                            console.error("\n--- model stream error ---");
                            console.error(event.error);
                            if (!responseCompleted) {
                                broadcast({ type: 'error_message', payload: `OpenAI Stream Error: ${event.error?.message || 'Unknown error'}` }); // <<< Broadcast API error
                                throw new Error(`OpenAI Stream Error: ${event.error?.message || 'Unknown error'}`); // Stop in case of API error
                            }
                        default:
                            // console.log("Unknown event type:", event.type);
                            break;
                        // Add other cases if necessary (e.g., response.input_processed)
                    }
                }
            } catch (streamError) {
                if (!responseCompleted) {
                    console.error("\n--- model stream processing error ---");
                    console.error(streamError);
                    broadcast({ type: 'error_message', payload: `OpenAI Stream Processing Error: ${streamError?.message || 'Unknown error'}` });
                    throw streamError; // Re-throw if we didn't complete successfully
                } else {
                    console.warn("Stream processing error occurred after response completion - ignoring and removing reasoning fields:", streamError?.message);

                    // Remove reasoning fields from the response output
                    if (finalResponse?.output && Array.isArray(finalResponse.output)) {
                        finalResponse.output = finalResponse.output.filter(item => item.type !== "reasoning");
                    }
                    // Remove all the "id" fields from the response output
                    if (finalResponse?.output && Array.isArray(finalResponse.output)) {
                        finalResponse.output = finalResponse.output.map(item => {
                            if (item.id) delete item.id;
                            return item;
                        });
                    }
                }
            }

            // 7. Process the final response (after the stream)
            if (!finalResponse) {
                throw new Error("No final response received from the OpenAI API after the stream.");
            }
            if (!state.skipNextUserMessage && newUserMessage) {
                state.history.push(newUserMessage);
            }
            setIsThinking(false);
            // Add response elements (reasoning, message, function call) to history
            // Handle reasoning replacement logic if necessary (WARNING: fragile)
            // let lastThinkingForReplacement = currentReasoning; // Use the streamed reasoning // Removed replacement logic
            //  DAEMONS: remember where this turn's own words start, so a turn
            //  that provably did nothing can be taken back out again. See the
            //  echo-chamber note after the tool calls below.
            const turnMark = state.history.length;
            const posBefore = gameDataJson?.current_trainer_data?.position || null;
            if (finalResponse.output) {
                finalResponse.output.forEach(item => {
                    // Specific logic to replace 'reasoning' in tool args REMOVED
                    state.history.push(item); // Add the item to the history
                });
            }

            state.skipNextUserMessage = false; // Reset the flag after processing the final response, handleToolCall will set it again if needed
            let haveToolCall = false;
            //  Every call that actually RAN, whichever path produced it. The
            //  loop guard below used to read finalResponse.output directly,
            //  which is empty on a salvaged turn -- and salvage is not the rare
            //  path here, it is 118 of 119 calls, because mlx-vlm's parser
            //  fails on nearly every one. So the guard was blind to almost
            //  every action the agent took, and fired once in a whole run.
            const executedCalls = [];
            // 8. Execute tool calls and add results to history
            if (finalResponse.output) {
                for (const item of finalResponse.output) {
                    if (item.type === "function_call") {
                        haveToolCall = true;
                        executedCalls.push(item);
                        // Pass gameDataJson AND the call_id (which is item.id)
                        setIsThinking(false);
                        const toolResult = await handleToolCall(item, gameDataJson);
                        state.history.push(toolResult); // Add the tool result to the history
                    }
                }
            }
            //  DAEMONS: before scolding the model for not calling a tool,
            //  check whether it DID and the serving layer dropped it.
            //
            //  mlx-vlm parses MiniCPM's XML with the qwen3_coder parser, which
            //  runs each <parameter> body through json.loads and then
            //  ast.literal_eval. When both fail it logs a warning and discards
            //  the whole call, and the text arrives here as ordinary prose. On
            //  a real run that was 25 of 55 requests -- nearly two turns in
            //  five doing nothing, which is most of why it looked like the
            //  model would not move.
            if (!haveToolCall) {
                const prose = (finalResponse.output || [])
                    .filter((item) => item.type === "message")
                    .flatMap((item) => item.content || [])
                    .map((part) => part.text || "")
                    .join("\n");
                const salvaged = salvageToolCalls(prose, tools);
                for (const call of salvaged) {
                    haveToolCall = true;
                    console.log(`INFO: [salvaged] recovered ${call.name} from a tool call the server could not parse`);
                    setIsThinking(false);
                    const item = {
                        type: "function_call",
                        id: `fc_salvaged_${Date.now()}`,
                        call_id: `salvaged_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
                        name: call.name,
                        arguments: call.arguments,
                    };
                    state.history.push(item);       // keep the transcript honest
                    executedCalls.push(item);
                    const toolResult = await handleToolCall(item, gameDataJson);
                    state.history.push(toolResult);
                }
            }

            if (!haveToolCall) {
                // Add a message to the history to remind the player to use tools
                state.history.push({
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "<system>You must include tools in your response ! Always call 'execute_action' tool with your messages to continue your actions !</system>" }
                    ]
                });
                state.skipNextUserMessage = true;
            }
            //  DAEMONS: do not let the model teach itself a mistake by repetition.
            //
            //  It decided the DAEMON Center was at (11,11) -- a tile that does
            //  not exist on a 12x9 map -- and walked east into a wall. Every
            //  correction we added landed: the pathfinder said OUTSIDE this
            //  map, key_press said YOU DID NOT MOVE, and it repeated the call
            //  anyway. Because by then the persisted history held 617
            //  occurrences of (11,11), 59 of them its own "Moving right to
            //  (11,11)". Each correction is one line per turn against six
            //  hundred repetitions in its own voice. It was not ignoring the
            //  feedback so much as being outvoted by itself.
            //
            //  Nothing trimmed assistant messages -- keepLastN* covers tool
            //  results and user messages only -- so a wrong plan restated every
            //  turn compounded, and it survived restarts in gpt_data.
            //
            //  So a turn that repeats the previous action AND moves nowhere is
            //  rolled back out of the history and replaced by one line saying
            //  it failed. The action already ran; this only decides what the
            //  model gets to read about it next turn. The function_call and its
            //  output are removed together, so the pairing the API requires
            //  stays intact.
            //  The signature is the ACTION, never the commentary. Including
            //  step_details and chat_message meant two identical `right`
            //  presses into the same wall compared as different turns, purely
            //  because the model reworded its own caption -- "Exploring
            //  rightward path to find important connections" one turn,
            //  "Moving right to explore important connections" the next. The
            //  guard then never fired on exactly the loop it exists to catch.
            const NARRATION = new Set(["step_details", "chat_message", "avatar_emotion", "explanation"]);
            const signature = executedCalls
                .map((item) => {
                    let args = item.arguments;
                    try {
                        const parsed = JSON.parse(item.arguments || "{}");
                        for (const key of Object.keys(parsed)) {
                            if (NARRATION.has(key)) delete parsed[key];
                        }
                        //  Stable key order, so a reordered object is still the
                        //  same action.
                        args = JSON.stringify(parsed, Object.keys(parsed).sort());
                    } catch (e) { /* unparseable: compare the raw string */ }
                    return `${item.name}:${args}`;
                })
                .join("|");
            if (signature) {
                let movedNowhere = false;
                try {
                    const after = await fetchGameData();
                    const a = after?.current_trainer_data?.position;
                    movedNowhere = Boolean(
                        posBefore && a && a.x === posBefore.x && a.y === posBefore.y
                        && a.map_id === posBefore.map_id
                    );
                } catch (e) { /* if we cannot tell, leave the history alone */ }

                if (movedNowhere && signature === state.lastNoMoveSignature) {
                    state.history.length = turnMark;
                    state.history.push({
                        role: "user",
                        content: [{
                            type: "input_text",
                            text: "<system>You just repeated an action that had already failed, and it "
                                + "failed again -- you did not move. That attempt has been removed from "
                                + "your history so you do not read it back as a plan. Do something "
                                + "DIFFERENT: a different direction, or look for stairs, a door or a warp "
                                + "to leave this map. If you are aiming at a tile, check it exists within "
                                + "the map size given above.</system>",
                        }],
                    });
                    console.log("INFO: [loop guard] rolled back a repeated action that moved nowhere");
                }
                state.lastNoMoveSignature = movedNowhere ? signature : null;
            }

            state.counters.currentStep++;
            //  One greppable line per turn. `grep PROGRESS` on two runs is the
            //  comparison we did not have yesterday.
            console.log(`Step counter incremented to: ${state.counters.currentStep}`);
            console.log(`PROGRESS step=${state.counters.currentStep} score=${state.progressScore} `
                + `badges=${state.progressNow.badges} maps=${state.progressNow.maps} `
                + `levels=${state.progressNow.partyLevels} caught=${state.progressNow.caught}`);
            if (state.selfCritiqueReminderAcknowledged) {
                state.selfCritiqueReminderPending = false; // Reminder satisfied after completing an action step
            }

            // Reset lastTotalTokens *after* a successful step (including summary/criticism steps which `continue`)
            // This ensures the token count from the *just completed* step is used for the *next* step's check.
            // If a summary happened due to tokens, we need to reset it.
            if (shouldSummarize) {
                state.lastTotalTokens = 0; // Reset after a summary is completed
                console.log("Reset lastTotalTokens after summary.");
            }
            setIsThinking(false);
            // 9. Save state (history, state.memory)
            await savePersistentState();


        } catch (error) {
            console.error("\n--- ERROR IN MAIN LOOP ---");
            console.error(error);
            console.error("Pausing for 10 seconds before retrying...");
            const downDuration = Date.now() - loopStartTime;
            recordDownTime(downDuration);
            broadcast({ type: 'error_message', payload: `Main loop error: ${error.message}` }); // <<< Broadcast loop error
            // Save state even in case of error (can be useful for debugging)
            // try {
            //     await savePersistentState();
            // } catch (saveError) {
            //     console.error("Error saving state during loop error handling:", saveError);
            // }
            await new Promise(resolve => setTimeout(resolve, 10000));
        } finally {
            const totalDuration = Date.now() - loopStartTime;
            recordTotal(totalDuration);
            await flush({ step: state.counters.currentStep, timestamp: new Date().toISOString() });
            await flushTime({ step: state.counters.currentStep, timestamp: new Date().toISOString() });
            // Always yield back to the event loop so WS handshakes are never starved
            await new Promise(setImmediate);
        }
    }
}

// --- Startup ---


module.exports = { gameLoop };
