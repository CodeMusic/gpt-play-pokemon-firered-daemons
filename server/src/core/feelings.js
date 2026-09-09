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

//  ONLY ONE OF THESE IS GENUINELY TWO-SIDED, and pretending otherwise was a
//  design error worth recording.
//
//  The first version gave all four a signed range and invented a negative pole
//  for each: FLAT, EVEN, LIFTED. None of them is a feeling anyone has. Worse,
//  CHOLERIC's true opposite is *calm* -- which is PHLEGMATIC's positive -- and
//  that collision is the tell: classically the humors are TWO OPPOSED PAIRS,
//  not four independent axes. Sanguine opposes Melancholic (hot+wet against
//  cold+dry); Choleric opposes Phlegmatic (hot+dry against cold+wet).
//
//  And the data already said so. Reading what readEvents can emit: SANGUINE
//  and CHOLERIC never receive a negative delta at all, MELANCHOLIC only once,
//  and PHLEGMATIC has four sources of it. Three bars could never leave the
//  right half, so a centred track was advertising a left side that would stay
//  empty forever.
//
//  So: three unsigned intensities, and one real axis with a word at each end.
const AXES = {
    //  humor          rises to    falls to    Board  type identity (6)
    SANGUINE:    { hi: "GLAD",  lo: null,     member: "I",   type: "VECTOR" },
    CHOLERIC:    { hi: "MAD",   lo: null,     member: "II",  type: "ENTROPY" },
    MELANCHOLIC: { hi: "SAD",   lo: null,     member: "III", type: "LATENT" },
    PHLEGMATIC:  { hi: "CALM",  lo: "AFRAID", member: "IV",  type: "FROZEN" },
};

//  An axis with no lower pole cannot go below nothing: you can be un-sad, but
//  there is no feeling on the far side of it.
const SIGNED = new Set(Object.entries(AXES).filter(([, a]) => a.lo).map(([k]) => k));

//  A drive rather than a humor, so it is kept out of AXES and off the humor
//  panel. It has no lower pole: there is nothing on the far side of not-bored.
const DRIVES = { BOREDOM: { hi: "RESTLESS" } };

//  BOREDOM IS NOT A HUMOR, and pretending it is one would break the mapping
//  that makes the other four worth having. It is a DRIVE: it rises when
//  nothing is happening and pushes outward, and it is the counterweight to
//  AFRAID -- which is exactly the deadlock worth breaking. An agent hiding
//  from tall grass because its daemon is hurt is behaving sensibly for a
//  while and then is simply stuck, and nothing in four humors ever gets it
//  moving again. Boredom does.
//
//  It is derived the same way everything else here is: from whether the
//  progress score has actually moved.
const LIMIT = 100;

//  Half-life in turns. Long enough that a faint still colours the next few
//  thoughts; short enough that step 20 is not still being felt at step 100.
const HALF_LIFE = 15;
const DECAY = Math.pow(0.5, 1 / HALF_LIFE);

function zero() {
    return { SANGUINE: 0, CHOLERIC: 0, MELANCHOLIC: 0, PHLEGMATIC: 0, BOREDOM: 0 };
}

function clamp(n, axis) {
    const floor = axis && !SIGNED.has(axis) ? 0 : -LIMIT;
    return Math.max(floor, Math.min(LIMIT, Math.round(n * 10) / 10));
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

    //  Boredom answers one question: has anything happened? Any real progress
    //  clears it outright; a turn where nothing moved adds to it. It climbs
    //  slowly, so it takes a genuine stretch of nothing to start pulling.
    const movedOn = now.badges > prev.badges || now.caught > prev.caught
        || now.maps > prev.maps || now.partyLevels > prev.partyLevels
        || now.seen > prev.seen;
    if (movedOn) bump("BOREDOM", -60, "something happened");
    else bump("BOREDOM", 3, "nothing is happening");

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

    //  BEING ANSWERED IS AN EVENT. Until now the backchannel was write-only in
    //  feeling terms: the agent could be told something and nothing about it
    //  changed. An answer settles you -- it is the opposite of getting nowhere,
    //  which is what CHOLERIC and BOREDOM are both counting.
    //
    //  Deliberately modest. If a reply wiped the board it would be a reset
    //  button, and an agent that learns to ask whenever it feels bad is asking
    //  for the feeling and not the answer.
    if (turn.answered) {
        bump("CHOLERIC", -22, "something answered");
        bump("BOREDOM", -30, "something answered");
        bump("PHLEGMATIC", 10, "something answered");
    }

    //  Frustration is repetition, not failure. One blocked move is a mistake;
    //  the third in the same place is the feeling this axis is for.
    if (turn.blockedStreak >= 1) {
        bump("CHOLERIC", Math.min(18, turn.blockedStreak * 5),
             `blocked ${turn.blockedStreak}x in a row`);
    }
    //  "Getting nowhere" used to push PHLEGMATIC negative -- which reads as
    //  AFRAID, and being stuck is not frightening, it is maddening. That was a
    //  stretch when it was the only axis available for it. BOREDOM is the
    //  right home for going nowhere and it exists now, so this comes out
    //  rather than double-counting into fear.
    if (turn.blockedStreak >= 3) bump("BOREDOM", 4, "getting nowhere");

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
        out[k] = clamp((Number(current?.[k]) || 0) * DECAY + (Number(deltas?.[k]) || 0), k);
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
    out.CHOLERIC = clamp(out.CHOLERIC * 0.15, "CHOLERIC");
    out.PHLEGMATIC = clamp(Math.max(out.PHLEGMATIC * 0.15, 0) + 22, "PHLEGMATIC");
    out.MELANCHOLIC = clamp(out.MELANCHOLIC * 0.6, "MELANCHOLIC");
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
        const name = v > 0 ? spec.hi : (spec.lo || spec.hi);
        const mag = Math.abs(v);
        const word = mag >= 55 ? "very " : mag >= 25 ? "" : "a little ";
        live.push({ axis, name, value: v, phrase: `${word}${name}`.trim() });
    }
    live.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return live;
}

//  Boredom speaks in what it makes you WANT, not in a number. "You are 56%
//  bored" is telemetry; "you have been in the same few tiles too long" is a
//  reason to walk somewhere.
function boredomLine(f) {
    const b = Number(f?.BOREDOM) || 0;
    if (b < 20) return null;
    if (b < 45) return "Nothing has happened for a while and you are starting to feel it.";
    if (b < 70) return "You have been going over the same ground too long. Somewhere you have "
        + "not been is worth the risk of getting there.";
    return "You are sick of this. Whatever you have been avoiding, it is now less "
        + "unpleasant than another turn of nothing.";
}

function formatForPrompt(f) {
    const live = describe(f);
    const bored = boredomLine(f);
    if (!live.length && !bored) {
        return "<feelings>\n  <note>Level. Nothing is pulling at you right now.</note>\n</feelings>\n";
    }
    return [
        "<feelings>",
        "  <note>How you actually feel this turn, not how you should. It moves with",
        "  what happens and settles back toward nothing on its own. Let it colour the",
        "  aside -- never name these words aloud and never explain them.</note>",
        ...live.map((l) => `  <feeling>${l.phrase}</feeling>`),
        ...(bored ? [`  <restlessness>${bored}</restlessness>`] : []),
        "</feelings>",
    ].join("\n") + "\n";
}

module.exports = { AXES, DRIVES, zero, readEvents, step, checkpoint, describe,
                   boredomLine, formatForPrompt, HALF_LIFE };
