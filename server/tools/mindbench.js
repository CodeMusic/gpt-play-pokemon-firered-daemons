#!/usr/bin/env node
//  DAEMONS (T-560): how well does a mind tool-call in THIS harness? A replay of a real run, through the real client.
//
//  Takes a recorded model input (the harness writes its last one; DAEMONS keeps one in ai/logs/last-input.json) and,
//  for each of its game states in turn, gives the mind the real history up to that state -- today's developer prompt,
//  today's tools (defineTools, flat or nested as DAEMONS_TOOLS says), the recorded calls and their recorded results --
//  and asks for the next action exactly as gameLoop.js does: tool_choice required, one call, streamed. Each turn is
//  scored on its own, so one bad answer cannot derail the rest:
//
//    ok        exactly one call, to a tool that exists, whose arguments parse and pass the tool's own schema
//    same      the tool the recorded run chose at that point (a sanity line, not a goal: a different call can be better)
//    seconds   wall time for the turn; tokens in and out
//
//  The mind is chosen as the harness chooses it (DAEMONS_MIND, DAEMONS_TIINY_MODEL, DAEMONS_THINK). Only use it on a
//  local mind: it makes one model call per turn. It prints one JSON line per turn and a summary; nothing it prints
//  carries a prompt.
//
//    DAEMONS_MIND=tiiny DAEMONS_TIINY_MODEL=35b DAEMONS_THINK=0 node tools/mindbench.js ../../DAEMONS/ai/logs/last-input.json 8

process.env.DAEMONS_TOOLS = process.env.DAEMONS_TOOLS || "flat";
process.env.DAEMONS_SCHEMA = process.env.DAEMONS_SCHEMA || "lean";
process.env.OPENAI_MAX_RETRIES = process.env.OPENAI_MAX_RETRIES || "0";
process.env.DAEMONS_MAX_OUTPUT_TOKENS = process.env.DAEMONS_MAX_OUTPUT_TOKENS || "4096";

const fs = require("fs");
const path = require("path");
const { config } = require("../src/config");
const { openai } = require("../src/core/openaiClient");
const { defineTools } = require("../src/ai/tools");
const { buildDeveloperPrompt } = require("../src/ai/promptBuilder");

const file = process.argv[2];
const maxTurns = Number(process.argv[3] || 8);
const keepImages = Number(process.env.DAEMONS_KEEP_IMAGES || 2);
if (!file) { console.error("usage: mindbench.js RECORDED_INPUT.json [TURNS]"); process.exit(2); }

const isState = (it) => it && it.role === "user" && JSON.stringify(it.content || "").includes("<game_state");

function withImagesOnlyOnLast(items, n) {
  let seen = 0;
  const out = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === "user" && Array.isArray(it.content) && it.content.some((c) => c.type === "input_image")) {
      seen++;
      if (seen > n) { out.unshift({ ...it, content: it.content.filter((c) => c.type !== "input_image") }); continue; }
    }
    out.unshift(it);
  }
  return out;
}

//  The arguments against the tool's own zod schema, when the tool keeps one.
function validates(toolDefs, name, args) {
  const t = toolDefs.find((d) => d.name === name);
  if (!t) return { ok: false, why: "no such tool" };
  let parsed;
  try { parsed = JSON.parse(args || "{}"); } catch { return { ok: false, why: "arguments are not JSON" }; }
  const req = t.parameters?.required || [];
  const missing = req.filter((k) => !(k in parsed));
  if (missing.length) return { ok: false, why: `missing ${missing.join(", ")}` };
  const props = t.parameters?.properties || {};
  for (const [k, v] of Object.entries(parsed)) {
    const p = props[k];
    if (!p) continue;
    if (p.enum && !p.enum.includes(v)) return { ok: false, why: `${k} not one of its values` };
    if (p.type === "array" && p.items?.enum && Array.isArray(v) && v.some((x) => !p.items.enum.includes(x))) return { ok: false, why: `${k} has a value outside its enum` };
  }
  return { ok: true };
}

(async () => {
  const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
  const developer = await buildDeveloperPrompt();
  const tools = defineTools();
  const flatTools = tools.filter((t) => t.type === "function");
  const base = recorded.filter((it) => !(it.role === "developer"));
  const stateIdx = base.map((it, i) => (isState(it) ? i : -1)).filter((i) => i >= 0);
  const turns = stateIdx.slice(0, maxTurns);
  const rows = [];
  for (const si of turns) {
    const history = withImagesOnlyOnLast(base.slice(0, si + 1).filter((it) => it.type !== "reasoning"), keepImages);
    const nextCall = base.slice(si + 1).find((it) => it.type === "function_call");
    const input = [{ role: "developer", content: typeof developer === "string" ? developer : developer.content }, ...history];
    const t0 = Date.now();
    let row = { turn: si, mind: process.env.DAEMONS_MIND_RESOLVED, model: config.openai.model, think: process.env.DAEMONS_THINK !== "0" };
    try {
      const stream = await openai.responses.create({
        model: config.openai.model, input, tools, tool_choice: "required", parallel_tool_calls: false,
        text: { format: { type: "text" } }, reasoning: { effort: config.openai.reasoningEffort, summary: "auto" },
        max_output_tokens: config.openai.maxOutputTokens, store: false, stream: true,
      });
      let final = null;
      let calls = 0;
      for await (const ev of stream) {
        if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") calls++;
        if (ev.type === "response.completed") final = ev.response;
      }
      const fc = (final?.output || []).filter((o) => o.type === "function_call");
      const first = fc[0];
      const v = first ? validates(flatTools, first.name, first.arguments) : { ok: false, why: "no tool call" };
      row = { ...row, seconds: +((Date.now() - t0) / 1000).toFixed(1), callsSent: calls, ok: v.ok && calls === 1, why: v.why,
              tool: first?.name || null, same: !!first && first.name === nextCall?.name,
              textChars: (final?.output_text || "").length, in: final?.usage?.input_tokens, out: final?.usage?.output_tokens };
    } catch (e) {
      row = { ...row, seconds: +((Date.now() - t0) / 1000).toFixed(1), ok: false, why: `error: ${String(e?.message || e).slice(0, 160)}` };
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const ok = rows.filter((r) => r.ok).length;
  const secs = rows.map((r) => r.seconds).sort((a, b) => a - b);
  const sum = { summary: true, mind: process.env.DAEMONS_MIND_RESOLVED, model: config.openai.model, think: process.env.DAEMONS_THINK !== "0",
                turns: rows.length, ok, same: rows.filter((r) => r.same).length,
                medianSeconds: secs[Math.floor(secs.length / 2)], maxSeconds: secs[secs.length - 1],
                meanOut: Math.round(rows.reduce((a, r) => a + (r.out || 0), 0) / Math.max(1, rows.length)) };
  console.log(JSON.stringify(sum));
})();
