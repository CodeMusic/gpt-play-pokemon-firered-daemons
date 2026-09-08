//  FEELINGS -- the fast layer.
//
//  <self> is a trait: stable, slow, "I commit to routes before checking them".
//  <dream> is a mood: episodic, one per fold. Neither of them moves when
//  something happens THIS turn, so the inner voice had no way to be affected
//  by anything. This is that.
//
//  FOUR SIGNED AXES, NAMED FOR THE HUMORS (6). The insight that fixed the
//  shape is that AFRAID is not a fifth thing -- it is Phlegmatic inverted.
//  Calm and afraid are one axis read in two directions, so four feelings need
//  four numbers rather than eight, and every one of them lands on a member of
//  the Review Board.
//
//  DERIVED, NEVER REPORTED. The model is not asked how it feels; the deltas
//  come from the same snapshot progress.js already takes each turn. Every
//  time this project has let a model assert something about itself the value
//  drifted, and every time it has read the game's own data instead it has been
//  right the first time.
//
//  HARNESS ONLY. A visible mechanic called FEELINGS inside the ROM would come
//  within a word of saying the thesis out loud, which invariant 1 forbids.
//  Here it is an instrument pointed at the player, not a statement the game
//  makes. If anyone ever proposes moving it into the game, that is the reason
//  not to.

const AXES = {
    //  humor          +pole      -pole      Board  type identity (6)
    SANGUINE:    { hi: "GLAD",  lo: "FLAT",   member: "I",   type: "VECTOR" },
    CHOLERIC:    { hi: "MAD",   lo: "EVEN",   member: "II",  type: "ENTROPY" },
    MELANCHOLIC: { hi: "SAD",   lo: "LIFTED", member: "III", type: "LATENT" },
    PHLEGMATIC:  { hi: "CALM",  lo: "AFRAID", member: "IV",  type: "FROZEN" },
};

const LIMIT = 100;

//  Half-life in turns. Long enough that a faint still colours the next few
//  thoughts; short enough that step 20 is not still being felt at step 100.
const HALF_LIFE = 15;
const DECAY = Math.pow(0.5, 1 / HALF_LIFE);

function zero() {
    return { SANGUINE: 0, CHOLERIC: 0, MELANCHOLIC: 0, PHLEGMATIC: 0 };
}

function clamp(n) {
    return Math.max(-LIMIT, Math.min(LIMIT, Math.round(n * 10) / 10));
}

//  What happened, read off the two snapshots and the turn's own facts.
//  Returns { deltas, events } -- events named so the dashboard can say WHY a
//  number moved, which is the difference between an instrument and a mood ring.
function readEvents(prev, now, turn = {}) {
    const d = zero();
    const events = [];
    const bump = (axis, n, why) => { d[axis] += n; events.push({ axis, n, why }); };

    if (!prev || !now) return { deltas: d, events };

    if (now.badges > prev.badges) bump("SANGUINE", 30, "a MARK earned");
    if (now.badges > prev.badges) bump("PHLEGMATIC", 12, "a MARK earned");
    if (now.caught > prev.caught) bump("SANGUINE", 14, "bound a daemon");
    if (now.partyLevels > prev.partyLevels) {
        bump("SANGUINE", Math.min(8, (now.partyLevels - prev.partyLevels) * 3), "levelled");
    }
    if (now.maps > prev.maps) {
        bump("SANGUINE", 5, "new ground");
        bump("PHLEGMATIC", -4, "new ground");   // unfamiliar: less settled
    }
    if (now.money < prev.money - 500) bump("MELANCHOLIC", 4, "spent heavily");

    //  The body. A party at low health is the clearest danger signal there is.
    if (typeof turn.hpFraction === "number") {
        if (turn.hpFraction <= 0) {
            bump("MELANCHOLIC", 26, "HALTED");
            bump("PHLEGMATIC", -22, "HALTED");
            bump("CHOLERIC", 8, "HALTED");
        } else if (turn.hpFraction < 0.34) {
            bump("PHLEGMATIC", -12, "badly hurt");
        } else if (turn.hpFraction > 0.9 && typeof turn.prevHpFraction === "number"
                   && turn.prevHpFraction < 0.5) {
            bump("PHLEGMATIC", 14, "restored");
            bump("MELANCHOLIC", -8, "restored");
        }
    }

    //  Frustration is repetition, not failure. One blocked move is a mistake;
    //  the third in the same place is the feeling this axis is for.
    if (turn.blockedStreak >= 1) {
        bump("CHOLERIC", Math.min(18, turn.blockedStreak * 5),
             `blocked ${turn.blockedStreak}x in a row`);
    }
    if (turn.blockedStreak >= 3) bump("PHLEGMATIC", -5, "getting nowhere");

    //  One event, however many axes it moved. The log said "HALTED, HALTED,
    //  HALTED" because a faint bumps three, and that reads as three faints.
    const seen = new Set();
    const unique = events.filter((e) => !seen.has(e.why) && seen.add(e.why));
    return { deltas: d, events: unique };
}

//  One turn of drift toward nothing, then whatever happened.
function step(current, deltas) {
    const out = zero();
    for (const k of Object.keys(out)) {
        out[k] = clamp((Number(current?.[k]) || 0) * DECAY + (Number(deltas?.[k]) || 0));
    }
    return out;
}

//  A CHECKPOINT restores health, and health is not the whole of it.
//
//  Zeroing all four would make healing an emotional lobotomy, and would throw
//  away the most interesting thing available at that exact moment: RELIEF.
//  So the two survival axes are released -- anger drops away, fear turns over
//  into calm -- and the two that are about how the run is GOING are left to
//  decay on their own. Walking in half-dead and walking out whole should feel
//  like something.
function checkpoint(current) {
    const out = { ...zero(), ...current };
    out.CHOLERIC = clamp(out.CHOLERIC * 0.15);
    out.PHLEGMATIC = clamp(Math.max(out.PHLEGMATIC * 0.15, 0) + 22);
    out.MELANCHOLIC = clamp(out.MELANCHOLIC * 0.6);
    return out;
}

//  Only what is actually being felt. A list of four numbers, three of them
//  near zero, reads as telemetry; naming the one or two that are live reads as
//  a state somebody is in.
function describe(f) {
    const live = [];
    for (const [axis, spec] of Object.entries(AXES)) {
        const v = Number(f?.[axis]) || 0;
        if (Math.abs(v) < 8) continue;
        const name = v > 0 ? spec.hi : spec.lo;
        const mag = Math.abs(v);
        const word = mag >= 55 ? "very " : mag >= 25 ? "" : "a little ";
        live.push({ axis, name, value: v, phrase: `${word}${name}`.trim() });
    }
    live.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return live;
}

function formatForPrompt(f) {
    const live = describe(f);
    if (!live.length) {
        return "<feelings>\n  <note>Level. Nothing is pulling at you right now.</note>\n</feelings>\n";
    }
    return [
        "<feelings>",
        "  <note>How you actually feel this turn, not how you should. It moves with",
        "  what happens and settles back toward nothing on its own. Let it colour the",
        "  aside -- never name these words aloud and never explain them.</note>",
        ...live.map((l) => `  <feeling>${l.phrase}</feeling>`),
        "</feelings>",
    ].join("\n") + "\n";
}

module.exports = { AXES, zero, readEvents, step, checkpoint, describe, formatForPrompt, HALF_LIFE };
