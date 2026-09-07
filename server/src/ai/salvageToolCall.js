//  DAEMONS: recover a tool call that the serving layer threw away.
//
//  MiniCPM emits tool calls in Qwen3-Coder's XML dialect, and mlx-vlm parses
//  it with that parser -- which converts each <parameter> body with json.loads
//  and then ast.literal_eval. When the model's JSON is imperfect BOTH fail,
//  the exception is caught, and the entire call is dropped with a warning. The
//  turn then produces no action at all.
//
//  Measured on a real run: 25 of 55 requests lost a call this way. Not an edge
//  case -- nearly two turns in five, which is most of why it looked like the
//  model was refusing to move.
//
//  Both observed shapes carry the model's full intent and fail only on syntax:
//
//    <parameter=keys>up,up,up,up</parameter>
//        a bare comma list where an array was declared. json.loads says no,
//        ast.literal_eval reads `up` as a Name and raises "malformed node".
//
//    <parameter=actions>["{", {"type": "key_press", "keys": ["A"]}}]</parameter>
//        a stray "{" element and one brace too many, wrapped around an object
//        that is itself perfectly well formed.
//
//  This is deliberately OUR code rather than a patch to site-packages: a
//  pip upgrade would silently revert a vendored fix and we would be reading
//  that 38% as model behaviour again.
const TAG = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
const PARAM = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;

//  Pull out every top-level {...} that balances, ignoring braces inside
//  strings. Recovers the good objects from a bad array without trusting the
//  brackets around them.
function balancedObjects(text) {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === "{") { if (depth === 0) start = i; depth++; }
        else if (c === "}") {
            depth--;
            if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
            else if (depth < 0) depth = 0;          // the extra brace: forgive it
        }
    }
    return out;
}

//  A bare list: "up,up,up" or "up up up" or one per line. Quotes and brackets
//  are stripped if the model half-committed to JSON.
function splitBareList(raw) {
    return raw
        .replace(/^[\s[(]+|[\s\])]+$/g, "")
        .split(/[,\n]+/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
}

function coerce(raw, schema) {
    const value = raw.replace(/^\n/, "").replace(/\n$/, "");
    const type = schema && typeof schema.type === "string" ? schema.type.toLowerCase() : null;

    if (type === "array" || type === "object") {
        try { return JSON.parse(value); } catch { /* fall through to repair */ }

        //  Objects first, and on the CONTENT rather than the declared item
        //  type: `actions` is a discriminated union, so items.type is absent
        //  and a type-led check falls through to the list splitter, which
        //  happily shreds {"type": "key_press", ...} into string fragments.
        //  That returns 25/25 "recovered" and every one of them unusable --
        //  a pass that is worse than a failure, because it looks like a pass.
        if (value.includes("{")) {
            const objs = [];
            for (const chunk of balancedObjects(value)) {
                try {
                    const o = JSON.parse(chunk);
                    if (o && typeof o === "object") objs.push(o);
                } catch { /* skip that one */ }
            }
            if (objs.length) return type === "array" ? objs : objs[0];
        }
        if (type === "array") {
            const parts = splitBareList(value);
            //  A fragment with a brace or a colon in it is wreckage, not a value.
            if (parts.length && !parts.some((p) => /[{}:]/.test(p))) return parts;
        }
        return null;                                 // unrecoverable; caller drops it
    }

    if (type === "integer" || type === "number") {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : value;
    }
    if (type === "boolean") return value.trim().toLowerCase() === "true";
    return value;
}

//  Walk the value against the schema, normalising where the model was only
//  careless about case and rejecting where it was actually wrong.
//
//  This has to descend through anyOf: `actions` is an array of a discriminated
//  union, so a top-level-only check never sees the `keys` enum inside it and
//  waves through ["A"] when the enum is lowercase. Keys are handed to the
//  emulator bridge verbatim, so a wrong case is a silent no-op -- the failure
//  that looks exactly like the model choosing not to move.
function fit(value, schema) {
    if (!schema || typeof schema !== "object") return { ok: true, value };

    if (Array.isArray(schema.anyOf)) {
        for (const branch of schema.anyOf) {
            const r = fit(value, branch);
            if (r.ok) return r;
        }
        return { ok: false };
    }

    const allowed = schema.enum || (schema.const !== undefined ? [schema.const] : null);
    if (allowed) {
        if (allowed.includes(value)) return { ok: true, value };
        if (typeof value === "string") {
            const hit = allowed.find(
                (a) => typeof a === "string" && a.toLowerCase() === value.toLowerCase()
            );
            if (hit) return { ok: true, value: hit };     // case only: normalise it
        }
        return { ok: false };
    }

    const type = typeof schema.type === "string" ? schema.type.toLowerCase() : null;
    if (type === "array") {
        if (!Array.isArray(value)) return { ok: false };
        const out = [];
        for (const item of value) {
            const r = fit(item, schema.items);
            if (!r.ok) return { ok: false };
            out.push(r.value);
        }
        return { ok: true, value: out };
    }
    if (type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
        for (const key of schema.required || []) {
            if (!(key in value)) return { ok: false };
        }
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const r = fit(v, schema.properties?.[k]);
            if (!r.ok) return { ok: false };
            out[k] = r.value;
        }
        return { ok: true, value: out };
    }
    if (type === "string" && typeof value !== "string") return { ok: false };
    if ((type === "integer" || type === "number") && typeof value !== "number") return { ok: false };
    if (type === "boolean" && typeof value !== "boolean") return { ok: false };
    return { ok: true, value };
}

/**
 * @param {string} text  assistant output that was returned as prose
 * @param {Array}  toolSchemas  what defineTools() produced for this request
 * @returns {Array<{name: string, arguments: string}>}
 */
function salvageToolCalls(text, toolSchemas) {
    if (typeof text !== "string" || !text.includes("<function=")) return [];
    const byName = new Map((toolSchemas || []).map((t) => [t.name, t.parameters?.properties || {}]));
    const calls = [];

    for (const [, name, body] of text.matchAll(TAG)) {
        if (!byName.has(name)) continue;             // never invent a tool
        const props = byName.get(name);
        const args = {};
        let usable = false;
        for (const [, key, raw] of body.matchAll(PARAM)) {
            const v = coerce(raw, props[key]);
            if (v === null) continue;
            args[key] = v;
            if (props[key]) usable = true;           // at least one real parameter
        }
        //  Recovering a call is only worth it if the call is VALID. A move we
        //  guessed at is worse than a turn we skip: the skip costs a retry,
        //  the guess walks the player somewhere it did not choose to go.
        if (!usable) continue;
        const schema = toolSchemas.find((t) => t.name === name);
        //  Narration is required by the schema but instructs nothing. Filling
        //  it costs nothing; dropping a valid key_press because the model
        //  skipped its own commentary would be the validator doing more damage
        //  than the malformed JSON did. An enum-typed one (avatar_emotion)
        //  must be filled from its OWN enum, or the check below rejects the
        //  value we just supplied.
        for (const key of schema?.parameters?.required || []) {
            if (key in args) continue;
            const spec = schema.parameters.properties?.[key];
            if (spec?.type !== "string") continue;
            args[key] = spec.enum
                ? (spec.enum.includes("default") ? "default" : spec.enum[0])
                : "(recovered from a malformed tool call)";
        }
        const fitted = fit(args, schema?.parameters);
        if (fitted.ok) calls.push({ name, arguments: JSON.stringify(fitted.value) });
    }
    return calls;
}

module.exports = { salvageToolCalls, balancedObjects, splitBareList };
