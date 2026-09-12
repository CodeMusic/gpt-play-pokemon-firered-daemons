//  THE AGENT AS PLAYTESTER.
//
//  It is walking through a game being built, and nobody has ever asked it what
//  it thought of the place. It has the one quality a human tester loses within
//  minutes and never gets back: it does not know what anything is supposed to
//  mean. A sign that reads as atmosphere to whoever wrote it reads as an
//  instruction to something arriving cold, and the gap between those is where
//  the design is actually failing.
//
//  THREE KINDS, and the colours are the point of having kinds at all -- a wall
//  of undifferentiated feedback is a wall.
//
//    LIKED      green   worth keeping, and worth knowing WHY it landed
//    DISLIKED   red     an actual complaint, not a difficulty
//    CONFUSED   amber   the valuable one: it could not tell what was meant
//
//  CONFUSED is why this exists. A tester who is confused and says so is
//  reporting a fact about the writing; a tester who is confused and works it
//  out has already stopped being able to report it.
//
//  NOTED WAS THE FOURTH AND IS REMOVED. The first run that filled this file at
//  all came back 0 liked, 0 disliked, 2 CONFUSED and 18 NOTED -- and sixteen of
//  the eighteen were play narration on consecutive turns: "Menu is open.",
//  "Need to get out of menu.", "JINX is selected." Both CONFUSED entries were
//  excellent, and one of them was a genuine bug report.
//
//  The fault was in the definition. "An observation with no verdict" gives the
//  model NO TEST TO FAIL, so it became the drawer everything went into. The
//  other three each demand a judgement the writer has to stand behind.
//
//  It was also a duplicate. `aside` is already "an observation with no
//  verdict" -- it has hundreds of them, it is read back into the prompt, and it
//  is where a thought about THIS TURN belongs. NOTED was a second aside
//  writing into the file meant for the people building the game.
//
//  THE TEST THAT REPLACES IT: would this still be true tomorrow, for somebody
//  else? "The east exit is higher up than it looks from here" survives the
//  turn. "Menu is open" does not, and is an aside.
//
//  KEPT SEPARATE FROM MEMORY on purpose. Memory is what the agent needs to
//  play better and it reads it back every turn. This is for the people making
//  the game, it is never returned to the agent, and it must never become
//  another thing for it to reason about.

const KINDS = ["LIKED", "DISLIKED", "CONFUSED"];
const MAX = 200;
//  A BACKSTOP, NOT THE FIX. Dropping NOTED removes the drawer; this stops the
//  same flooding arriving under another label. Entries came in on steps 1100,
//  1101, 1102 ... 1116 -- one per turn, because only the NUDGE was rate-limited
//  and the field is present on every action. Two genuine findings inside
//  fifteen steps is rare, and the second is usually the first restated.
const MIN_STEPS_BETWEEN = 15;

function record(state, { kind, about, note, mapName, step }) {
    const k = String(kind || "").toUpperCase();
    if (!KINDS.includes(k)) return null;
    const text = String(note || "").trim();
    if (text.length < 12) return null;
    if (!Array.isArray(state.playtest)) state.playtest = [];

    const now = Number(step) || 0;
    const last = state.playtest.length ? Number(state.playtest[state.playtest.length - 1].step) || 0 : -Infinity;
    if (now - last < MIN_STEPS_BETWEEN) {
        //  NULL, not a {throttled} object. Both call sites do
        //  `actionResult.success = Boolean(entry)` and then `if (entry)`, so a
        //  truthy sentinel would report success and then read .kind off
        //  something that has none. Same shape as every other refusal here.
        console.log(`INFO: playtest throttled (${now - last} steps since the last entry, ${MIN_STEPS_BETWEEN} wanted)`);
        return null;
    }

    const entry = {
        id: `f${Date.now().toString(36)}`,
        kind: k,
        about: String(about || "").trim().slice(0, 80),
        note: text.slice(0, 600),
        map: String(mapName || ""),
        step: Number(step) || 0,
        at: Date.now(),
    };
    state.playtest.push(entry);
    if (state.playtest.length > MAX) state.playtest.splice(0, state.playtest.length - MAX);
    return entry;
}

function tally(list) {
    const out = { LIKED: 0, DISLIKED: 0, CONFUSED: 0 };
    for (const e of (Array.isArray(list) ? list : [])) {
        if (out[e.kind] !== undefined) out[e.kind] += 1;
    }
    return out;
}

module.exports = { KINDS, record, tally, MAX };
