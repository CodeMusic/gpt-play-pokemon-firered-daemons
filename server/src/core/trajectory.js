//  What the critique could not see, and why it was confidently wrong.
//
//  Self-critique was disabled after it reported "No loops detected; the player
//  is systematically exploring" during an hour of walking into the same wall
//  from the same tile. That was not the model being stupid. It was asked to
//  detect loops and handed the CURRENT state -- one position, one screen. A
//  loop is a property of a TRAJECTORY, and nothing in its input contained one.
//
//  This builds the missing half: what has actually happened over the last N
//  steps, counted rather than described. Everything here is derived from the
//  history the agent itself produced -- the same principle that made the BFS
//  pathfinder reliable while the hand-written exits rules needed four passes.

const POS = /Player Position \(Map Coords\): X=(-?\d+), Y=(-?\d+)/;
const MAP = /Map Name: ([A-Z0-9_]+)/;

function textOf(item) {
    if (typeof item?.content === "string") return item.content;
    if (Array.isArray(item?.content)) {
        return item.content
            .map((c) => (typeof c === "string" ? c : c?.text || ""))
            .join("\n");
    }
    return "";
}

//  Walk the history newest-first and stop at `limit` observed steps, so the
//  digest describes the recent past rather than the whole run.
function collect(history, limit) {
    const places = [];   // "MAP x,y", oldest-last
    const actions = [];  // tool names, oldest-last
    for (let i = history.length - 1; i >= 0 && places.length < limit; i--) {
        const item = history[i];
        if (item?.type === "function_call") {
            //  BOTH tool shapes. DAEMONS_TOOLS=flat -- the default, and what
            //  every run so far has used -- stores the tool name on the item
            //  and its parameters directly in `arguments`; there is no
            //  `actions` array to read. Reading only the nested shape reported
            //  "Tools used: none recorded" against a history with 19 calls in
            //  it, which is the digest lying quietly rather than failing.
            if (item.name && item.name !== "execute_action") {
                actions.push(item.name);
            } else {
                try {
                    const args = JSON.parse(item.arguments || "{}");
                    for (const a of args.actions || []) if (a?.type) actions.push(a.type);
                } catch (e) { /* a malformed call tells us nothing; skip it */ }
            }
            continue;
        }
        if (item?.role !== "user") continue;
        const body = textOf(item);
        const p = POS.exec(body);
        const m = MAP.exec(body);
        if (p) places.push(`${m ? m[1] : "?"} ${p[1]},${p[2]}`);
    }
    places.reverse();
    actions.reverse();
    return { places, actions };
}

function digest(history, opts = {}) {
    const limit = opts.limit || 40;
    const { places, actions } = collect(Array.isArray(history) ? history : [], limit);
    if (places.length < 4) return null;   // too little to say anything honest

    const counts = places.reduce((a, p) => ((a[p] = (a[p] || 0) + 1), a), {});
    const distinct = Object.keys(counts).length;
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const maps = [...new Set(places.map((p) => p.split(" ")[0]))];
    const acts = actions.reduce((a, t) => ((a[t] = (a[t] || 0) + 1), a), {});

    const lines = [
        `Steps examined: ${places.length}`,
        `Distinct positions: ${distinct} of ${places.length}`
            + ` (${Math.round((distinct / places.length) * 100)}% of your moves went somewhere new)`,
        `Maps entered: ${maps.length} -- ${maps.join(", ")}`,
        `Most-revisited position: ${ranked[0][0]} (${ranked[0][1]} times)`,
    ];
    if (ranked.length > 1 && ranked[1][1] > 1) {
        lines.push(`Next most: ${ranked.slice(1, 4).filter(([, n]) => n > 1)
            .map(([p, n]) => `${p} (${n}x)`).join(", ")}`);
    }
    lines.push(`Tools used: ${Object.entries(acts).sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t} ${n}x`).join(", ") || "none recorded"}`);

    //  State the arithmetic, never the verdict. If this said "you are looping",
    //  the critique would be agreeing with a number rather than reading the
    //  run -- and a wrong number would then be laundered into a confident
    //  conclusion, which is the exact failure this is meant to fix.
    lines.push("");
    lines.push("These are counts, not conclusions. A low distinct-position ratio can mean"
        + " a loop, or a long fight, or careful menu work. Read the run and decide.");
    return lines.join("\n");
}

module.exports = { digest };
