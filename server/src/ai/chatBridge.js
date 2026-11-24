// BRAIN: none -- a protocol adapter: the Responses API answered over chat completions, as ollama.ts
//  DAEMONS (T-560): the Responses API, spoken over chat completions.
//
//  The harness was written against openai.responses.create() -- typed stream events, `input` items, flat function
//  tools. The local minds (the Tiiny, and LiteLLM in front of it) do that badly or not at all: the Tiiny's own
//  /v1/responses refuses images, `reasoning` and the thinking switch (mind.js has the measurements). Their
//  /v1/chat/completions does all three. Rather than touch the six call sites, this answers responses.create() itself:
//  it turns the request into a chat request, and the chat answer back into a response and the events the harness reads
//  (output_item.added / .done, output_text.delta, reasoning_summary_text.delta, completed, error).
//
//  What maps to what:
//    developer/system message   -> system, folded into the first one (Qwen's template takes one, at the start)
//    later developer messages    -> a user message marked [developer], so the order is kept
//    input_text / output_text    -> text;  input_image -> image_url
//    reasoning items              -> dropped (a chat mind keeps none between calls)
//    function_call                -> an assistant message's tool_calls
//    function_call_output         -> a tool message (its text); any images in it follow as a user message
//    tools (type function)        -> {type:function, function:{...}}; anything else (code_interpreter) is dropped
//    max_output_tokens            -> max_tokens;  text.format json_schema -> response_format
//    reasoning.effort             -> chat_template_kwargs.enable_thinking: on unless the effort is none/minimal,
//                                    and off everywhere with DAEMONS_THINK=0
//    parallel_tool_calls: false  -> passed on, and only the first call kept if a mind sends more anyway
//  `store`, `service_tier`, `include` and `reasoning.summary` have no chat meaning and are not sent.

const textOf = (content) => {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((c) => c && (c.type === "input_text" || c.type === "output_text" || c.type === "text" || c.type === "summary_text"))
    .map((c) => c.text || "")
    .join("\n");
};

const imagesOf = (content) =>
  Array.isArray(content) ? content.filter((c) => c && c.type === "input_image" && c.image_url) : [];

function chatContent(content) {
  if (typeof content === "string") return content;
  const parts = [];
  for (const c of content || []) {
    if (!c) continue;
    if (c.type === "input_text" || c.type === "output_text" || c.type === "text") parts.push({ type: "text", text: c.text || "" });
    else if (c.type === "input_image" && c.image_url) {
      const url = typeof c.image_url === "string" ? c.image_url : c.image_url.url;
      parts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (parts.length && parts.every((p) => p.type === "text")) return parts.map((p) => p.text).join("\n");
  return parts;
}

function toMessages(body) {
  const out = [];
  const system = [];
  if (body.instructions) system.push(String(body.instructions));
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input || [];
  let lastAssistant = null;
  for (const item of input) {
    if (!item) continue;
    const role = item.role;
    const type = item.type || (role ? "message" : undefined);
    if (type === "reasoning") continue;
    if (type === "function_call") {
      const call = { id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } };
      if (lastAssistant && out[out.length - 1] === lastAssistant) {
        lastAssistant.tool_calls = lastAssistant.tool_calls || [];
        lastAssistant.tool_calls.push(call);
      } else {
        lastAssistant = { role: "assistant", content: null, tool_calls: [call] };
        out.push(lastAssistant);
      }
      continue;
    }
    if (type === "function_call_output") {
      const o = item.output;
      const text = typeof o === "string" ? o : textOf(o) || (o == null ? "" : JSON.stringify(o));
      out.push({ role: "tool", tool_call_id: item.call_id, content: text || "(done)" });
      const imgs = imagesOf(o);
      if (imgs.length) out.push({ role: "user", content: chatContent(imgs) });
      lastAssistant = null;
      continue;
    }
    if (type === "message" || role) {
      if (role === "developer" || role === "system") {
        const t = textOf(item.content);
        if (!out.length) system.push(t);
        else out.push({ role: "user", content: `[developer]\n${t}` });
        lastAssistant = null;
        continue;
      }
      if (role === "assistant") {
        lastAssistant = { role: "assistant", content: textOf(item.content) };
        out.push(lastAssistant);
        continue;
      }
      out.push({ role: "user", content: chatContent(item.content) });
      lastAssistant = null;
    }
  }
  //  A tool call the history never answered (a crash between call and output) is refused by strict templates.
  const answered = new Set(out.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const m of out) {
    if (m.tool_calls) {
      m.tool_calls = m.tool_calls.filter((c) => answered.has(c.id));
      if (!m.tool_calls.length) delete m.tool_calls;
      if (m.content == null && !m.tool_calls) m.content = "";
    }
  }
  if (system.length) out.unshift({ role: "system", content: system.join("\n\n") });
  return out;
}

function toChatBody(body) {
  const chat = { model: body.model, messages: toMessages(body) };
  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature != null) chat.temperature = body.temperature;
  const tools = (body.tools || []).filter((t) => t && t.type === "function").map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } },
  }));
  if (tools.length) {
    chat.tools = tools;
    if (body.tool_choice) chat.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice
      : (body.tool_choice.name ? { type: "function", function: { name: body.tool_choice.name } } : "auto");
    if (body.parallel_tool_calls === false) chat.parallel_tool_calls = false;
  }
  const fmt = body.text?.format;
  if (fmt && fmt.type === "json_schema") {
    chat.response_format = { type: "json_schema", json_schema: { name: fmt.name || "out", schema: fmt.schema, strict: !!fmt.strict } };
  } else if (fmt && fmt.type === "json_object") {
    chat.response_format = { type: "json_object" };
  }
  const effort = String(body.reasoning?.effort || "").toLowerCase();
  const think = process.env.DAEMONS_THINK !== "0" && !["none", "minimal", ""].includes(effort);
  //  The thinking switch is Qwen's template's, which the Tiiny and LiteLLM pass on; OpenRouter is not sent it.
  if (process.env.DAEMONS_THINK_SWITCH !== "0") chat.chat_template_kwargs = { enable_thinking: think };
  //  Anything a mind needs in every request (OpenRouter's provider pin), from mind.js.
  if (process.env.DAEMONS_CHAT_EXTRA) {
    try { Object.assign(chat, JSON.parse(process.env.DAEMONS_CHAT_EXTRA)); } catch { /* ignored */ }
  }
  return chat;
}

//  Some templates leak the thinking into the answer as <think>...</think>; it belongs in reasoning.
function splitThink(text) {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(text || "");
  return m ? { reasoning: m[1], text: (text || "").slice(m[0].length) } : { reasoning: "", text: text || "" };
}

let seq = 0;
const rid = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

function usageOf(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

function buildResponse(body, { reasoning, text, calls, usage }) {
  const output = [];
  if (reasoning) output.push({ id: rid("rs"), type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] });
  if (text) output.push({ id: rid("msg"), type: "message", role: "assistant", status: "completed",
                           content: [{ type: "output_text", text, annotations: [] }] });
  let kept = calls;
  if (body.parallel_tool_calls === false && kept.length > 1) kept = kept.slice(0, 1);
  for (const c of kept) {
    const callId = c.id || rid("call");
    output.push({ id: rid("fc"), type: "function_call", status: "completed", call_id: callId, name: c.name, arguments: c.arguments || "{}" });
  }
  return { id: rid("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
           model: body.model, output, output_text: text || "", usage: usageOf(usage) };
}

async function* streamEvents(chatClient, body, chat, opts) {
  const stream = await chatClient.chat.completions.create({ ...chat, stream: true, stream_options: { include_usage: true } }, opts);
  let reasoning = "";
  let text = "";
  let usage = null;
  const calls = [];
  let rsItem = null;
  let msgItem = null;
  let inThinkTag = false;
  yield { type: "response.created", response: { id: rid("resp"), status: "in_progress", model: body.model } };
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const d = chunk.choices?.[0]?.delta;
    if (!d) continue;
    const r = d.reasoning_content || d.reasoning || "";
    if (r) {
      if (!rsItem) { rsItem = { id: rid("rs"), type: "reasoning", summary: [] }; yield { type: "response.output_item.added", item: rsItem }; }
      reasoning += r;
      yield { type: "response.reasoning_summary_text.delta", delta: r };
    }
    if (d.content) {
      let piece = d.content;
      //  A <think> block arriving in the content stream is reasoning too.
      if (!text && !inThinkTag && /^\s*<think>/.test(piece)) { inThinkTag = true; piece = piece.replace(/^\s*<think>/, ""); }
      if (inThinkTag) {
        const end = piece.indexOf("</think>");
        const part = end >= 0 ? piece.slice(0, end) : piece;
        if (part) {
          if (!rsItem) { rsItem = { id: rid("rs"), type: "reasoning", summary: [] }; yield { type: "response.output_item.added", item: rsItem }; }
          reasoning += part;
          yield { type: "response.reasoning_summary_text.delta", delta: part };
        }
        if (end < 0) continue;
        inThinkTag = false;
        piece = piece.slice(end + "</think>".length).replace(/^\s+/, "");
        if (!piece) continue;
      }
      if (!msgItem) {
        if (rsItem) { yield { type: "response.reasoning_summary_part.done" }; yield { type: "response.output_item.done", item: rsItem }; }
        msgItem = { id: rid("msg"), type: "message", role: "assistant", content: [] };
        yield { type: "response.output_item.added", item: msgItem };
      }
      text += piece;
      yield { type: "response.output_text.delta", delta: piece };
    }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      if (!calls[i]) {
        calls[i] = { id: tc.id, name: tc.function?.name || "", arguments: "" };
        yield { type: "response.output_item.added", item: { type: "function_call", name: calls[i].name } };
      }
      if (tc.id && !calls[i].id) calls[i].id = tc.id;
      if (tc.function?.name && !calls[i].name) calls[i].name = tc.function.name;
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
    }
  }
  const response = buildResponse(body, { reasoning, text, calls: calls.filter(Boolean), usage });
  if (rsItem && !msgItem) yield { type: "response.output_item.done", item: response.output.find((o) => o.type === "reasoning") };
  for (const item of response.output) if (item.type !== "reasoning") yield { type: "response.output_item.done", item };
  yield { type: "response.completed", response };
}

//  EVERY IMAGE FLATTENED TO RGB. The harness's overworld overlay (screenshotService.js: the grid composited by sharp)
//  is an RGBA PNG; every other screenshot is RGB. On 2026-11-14 the one bench turn that carried the overlay failed with
//  "Upstream model server request failed" on both Qwen models, and each time the Tiiny then UNLOADED the model --
//  three times, taking the companion's own talk down with it -- while a single RGB 720x480 screenshot two turns
//  earlier was fine. So nothing with an alpha channel reaches a chat mind. DAEMONS_MAX_IMAGES_PER_MESSAGE (default 1)
//  also keeps only the first image of any one message (the clean screenshot), until two at once are proven safe there.
let sharp = null;
try { sharp = require("sharp"); } catch { /* without sharp, images go as they are */ }
const MAX_IMAGES = Number(process.env.DAEMONS_MAX_IMAGES_PER_MESSAGE ?? 1);

async function flattenImages(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    const imgs = m.content.filter((c) => c.type === "image_url");
    if (MAX_IMAGES >= 0 && imgs.length > MAX_IMAGES) {
      //  Keep the FIRST: the harness sends the clean screenshot first and the grid overlay second, and the 35B, shown
      //  the overlay alone, described a Blanche Town screen as "a colorful, grid-based multiplication table".
      const drop = new Set(imgs.slice(MAX_IMAGES));
      m.content = m.content.filter((c) => !drop.has(c));
    }
    if (!sharp) continue;
    for (const c of m.content) {
      if (c.type !== "image_url") continue;
      const url = c.image_url?.url || "";
      const at = url.indexOf(";base64,");
      if (!url.startsWith("data:image/") || at < 0) continue;
      try {
        const buf = Buffer.from(url.slice(at + 8), "base64");
        const meta = await sharp(buf).metadata();
        if (!meta.hasAlpha && meta.channels === 3 && meta.format === "png") continue;
        const out = await sharp(buf).flatten({ background: "#000000" }).removeAlpha().png().toBuffer();
        c.image_url = { url: `data:image/png;base64,${out.toString("base64")}` };
      } catch { /* an image sharp cannot read is left as it was */ }
    }
  }
  return messages;
}

//  responses.create(body, opts) for a chat-completions mind. Streams when body.stream does, as the SDK would.
function makeResponsesCreate(chatClient) {
  return async function create(body, opts) {
    const chat = toChatBody(body);
    await flattenImages(chat.messages);
    if (body.stream) {
      const it = streamEvents(chatClient, body, chat, opts);
      //  Fail as the SDK does -- on the create() call, not on the first event -- when the mind refuses the request.
      const first = await it.next();
      return {
        [Symbol.asyncIterator]() {
          let firstDone = false;
          return {
            next: () => (firstDone ? it.next() : ((firstDone = true), Promise.resolve(first))),
            return: (v) => it.return(v),
          };
        },
      };
    }
    const r = await chatClient.chat.completions.create(chat, opts);
    const m = r.choices?.[0]?.message || {};
    const split = splitThink(m.content || "");
    const calls = (m.tool_calls || []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments }));
    return buildResponse(body, { reasoning: m.reasoning_content || m.reasoning || split.reasoning, text: split.text, calls, usage: r.usage });
  };
}

module.exports = { makeResponsesCreate, toChatBody, toMessages, flattenImages };
