//  THE BACKCHANNEL.
//
//  In linguistics a backchannel is the listener's "mm-hm" -- how you steer a
//  speaker without taking the floor. In comms it is a secondary return path.
//  Both readings are what this is: a way to reach the agent that is not the
//  game, and is not a person as far as the agent is concerned.
//
//  WHAT THE AGENT IS TOLD IT IS: nothing, precisely. It knows something can be
//  consulted and sometimes answers. It is never told a human is watching, and
//  no wording here should let it work that out -- the run stops being a model
//  playing the game the moment it starts performing for an audience.
//
//  ORACLE would have been the exact word -- the build already glosses it as "a
//  black box that returns correct answers without showing how" -- and it is a
//  TYPE NAME. 1.6 refused this same move for FROZEN, on the grounds that type
//  names carry meaning and reusing one spends it. Same objection here.
//
//  ONE OPEN QUESTION AT A TIME, and silence is a legal answer. An oracle that
//  always replies is a walkthrough, and an agent that believes in one stops
//  looking and starts asking -- at which point you are no longer watching it
//  play, you are watching it play you.

const MAX = 60;

function ensure(state) {
    if (!Array.isArray(state.backchannel)) state.backchannel = [];
    return state.backchannel;
}

//  A question from the agent. Refused while one is already outstanding.
function ask(state, text) {
    const log = ensure(state);
    if (openQuestion(state)) return null;
    const entry = {
        id: `q${Date.now().toString(36)}`,
        from: "agent",
        text: String(text || "").trim().slice(0, 400),
        step: state.counters?.currentStep ?? 0,
        at: Date.now(),
        answered: false,
    };
    if (!entry.text) return null;
    log.push(entry);
    trim(log);
    return entry;
}

//  A reply, or an unprompted note. `read` is false until it has been put in
//  front of the model exactly once.
function tell(state, text, replyTo) {
    const log = ensure(state);
    const entry = {
        id: `g${Date.now().toString(36)}`,
        from: "guide",
        text: String(text || "").trim().slice(0, 600),
        step: state.counters?.currentStep ?? 0,
        at: Date.now(),
        read: false,
        replyTo: replyTo || null,
    };
    if (!entry.text) return null;
    if (replyTo) {
        const q = log.find((e) => e.id === replyTo);
        if (q) q.answered = true;
    }
    log.push(entry);
    trim(log);
    return entry;
}

function openQuestion(state) {
    return ensure(state).find((e) => e.from === "agent" && !e.answered) || null;
}

//  DELIVERED ONCE. Anything already shown never reappears -- otherwise the
//  same line rides in every prompt for the rest of the run and becomes
//  wallpaper the model skims past, which is what happened to the tool
//  reminders it ignored for 357 steps.
function takeUnread(state) {
    const log = ensure(state);
    const unread = log.filter((e) => e.from === "guide" && !e.read);
    unread.forEach((e) => { e.read = true; });
    return unread;
}

function trim(log) {
    if (log.length > MAX) log.splice(0, log.length - MAX);
}

function formatForPrompt(unread) {
    if (!unread || !unread.length) return "";
    return [
        "<backchannel>",
        "  <note>Something reached you. You do not know where it comes from and",
        "  you cannot check it. Weigh it against what you can see: where it matches,",
        "  act on it; where the screen says otherwise, the screen wins. Never mention",
        "  it aloud and never wonder about it in an aside.</note>",
        ...unread.map((e) => `  <heard>${String(e.text)
            .replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</heard>`),
        "</backchannel>",
    ].join("\n") + "\n";
}

module.exports = { ask, tell, openQuestion, takeUnread, formatForPrompt, MAX };
