//  DAEMONS: a number for how the run is actually going.
//
//  Yesterday every comparison between models was "seems better" -- and the one
//  time it was measured properly it reversed the conclusion twice. This exists
//  so a run can be judged without watching it, and two models compared without
//  anyone remembering how the last one felt.
//
//  Everything here is already read from RAM every turn. Nothing new is
//  computed about the game; it is only counted.
const WEIGHTS = {
    badge: 1000,      //  the spine of the game -- eight of them IS the game
    map: 40,          //  new ground seen. Cheap individually, the bulk early on
    partyLevel: 6,    //  summed across the party
    caught: 25,       //  a daemon is a decision, not a step
    seen: 4,          //  cheaper: seeing one is a side effect of walking
    money: 0.002,     //  1000 currency = 2 points. Real signal, weak signal
};

function snapshot(gameDataJson, state) {
    const t = gameDataJson?.current_trainer_data || {};
    const badges = Object.values(t.badges || {}).filter(Boolean).length;
    const party = Array.isArray(gameDataJson?.current_pokemon_data) ? gameDataJson.current_pokemon_data : [];
    const levels = party.reduce((n, p) => n + (Number(p?.level) || 0), 0);
    //  Maps visited is ours, not the game's -- the harness records it, so it
    //  survives a reload the way a RAM read would not.
    const maps = Array.isArray(state?.lastVisitedMaps)
        ? new Set(state.lastVisitedMaps.map((m) => m.map_id)).size
        : (state?.mapVisits ? Object.keys(state.mapVisits).length : 0);
    const dex = gameDataJson?.pokedex_data || {};
    return {
        badges,
        maps,
        partyLevels: levels,
        partySize: party.length,
        caught: Number(dex.owned) || party.length,
        seen: Number(dex.seen) || 0,
        money: Number(t.money) || 0,
    };
}

function score(s) {
    return Math.round(
        s.badges * WEIGHTS.badge
        + s.maps * WEIGHTS.map
        + s.partyLevels * WEIGHTS.partyLevel
        + s.caught * WEIGHTS.caught
        + s.seen * WEIGHTS.seen
        + s.money * WEIGHTS.money
    );
}

//  What the MODEL gets is a delta in words, not the scalar.
//
//  A score going up does not tell anyone what to do next -- it is a fact about
//  the past. "2 new maps, no battles won since your last objective" is
//  something a next action can answer. The number is for judging RUNS; the
//  sentence is for steering one.
function delta(now, then) {
    if (!then) return null;
    const parts = [];
    const add = (n, one, many) => { if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`); };
    add(now.badges - then.badges, "new badge", "new badges");
    add(now.maps - then.maps, "new map", "new maps");
    add(now.caught - then.caught, "daemon caught", "daemons caught");
    const lv = now.partyLevels - then.partyLevels;
    if (lv > 0) parts.push(`${lv} level${lv === 1 ? "" : "s"} gained`);
    const money = now.money - then.money;
    if (money > 0) parts.push(`${money} earned`);
    if (!parts.length) return "NOTHING has changed since then -- no new ground, no levels, no badges.";
    return "Since then: " + parts.join(", ") + ".";
}

module.exports = { snapshot, score, delta, WEIGHTS };
