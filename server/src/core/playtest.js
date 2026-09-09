//  THE AGENT AS PLAYTESTER.
//
//  It is walking through a game being built, and nobody has ever asked it what
//  it thought of the place. It has the one quality a human tester loses within
//  minutes and never gets back: it does not know what anything is supposed to
//  mean. A sign that reads as atmosphere to whoever wrote it reads as an
//  instruction to something arriving cold, and the gap between those is where
//  the design is actually failing.
//
//  FOUR KINDS, and the colours are the point of having kinds at all -- a wall
//  of undifferentiated feedback is a wall.
//
//    LIKED      green   worth keeping, and worth knowing WHY it landed
//    DISLIKED   red     an actual complaint, not a difficulty
//    CONFUSED   amber   the valuable one: it could not tell what was meant
//    NOTED      blue    an observation with no verdict attached
//
//  CONFUSED is why this exists. A tester who is confused and says so is
//  reporting a fact about the writing; a tester who is confused and works it
//  out has already stopped being able to report it.
//
//  KEPT SEPARATE FROM MEMORY on purpose. Memory is what the agent needs to
//  play better and it reads it back every turn. This is for the people making
//  the game, it is never returned to the agent, and it must never become
//  another thing for it to reason about.

const KINDS = ["LIKED", "DISLIKED", "CONFUSED", "NOTED"];
const MAX = 200;

function record(state, { kind, about, note, mapName, step }) {
    const k = String(kind || "").toUpperCase();
    if (!KINDS.includes(k)) return null;
    const text = String(note || "").trim();
    if (text.length < 12) return null;
    if (!Array.isArray(state.playtest)) state.playtest = [];

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
    const out = { LIKED: 0, DISLIKED: 0, CONFUSED: 0, NOTED: 0 };
    for (const e of (Array.isArray(list) ? list : [])) {
        if (out[e.kind] !== undefined) out[e.kind] += 1;
    }
    return out;
}

module.exports = { KINDS, record, tally, MAX };
