//  DAEMONS: pathfinding that does not leave the machine.
//
//  Upstream's findPath asks a frontier model to WRITE PYTHON, uploads it to an
//  OpenAI Code Interpreter container, and runs it there -- openai.containers
//  .create() plus hardcoded https://api.openai.com/v1/containers URLs that no
//  proxy setting redirects. So it is the one tool in the harness that cannot
//  be pointed at a local model: with OPENAI_API_KEY unset it fails five times
//  and stalls the run.
//
//  It also never needed any of that. Every input is already in the process:
//  the collision grid arrives with each frame, and src/constants/tiles.js
//  labels every id. A breadth-first search over that grid is exact, instant,
//  free, and unlike a model it cannot return a path that walks through a wall.
//
//  Conservative by design: tiles whose movement is not plain (ledges, ice,
//  spinners, arrow floors, holes, water) are treated as blocked rather than
//  guessed at. That can make a route longer, or report no route where a
//  ledge-hop existed. It cannot make a route that is wrong -- and a wrong path
//  costs a bumped wall and a confused model, while a long one costs nothing.
const { MARKDOWN_TILES } = require("../constants/tiles.js");

//  Blocked unless proven otherwise. The legend already says "(Collision)" on
//  everything solid, so that half is derived rather than transcribed; the rest
//  is movement we decline to model.
const SPECIAL_BLOCKED = new Set([
    0,                          // Wall
    25,                         // OOB (Collision)
    3, 4, 50, 51, 52, 53, 54,   // water, waterfall, currents, dive -- needs Surf
    5, 6, 7, 8,                 // ledges: one-way, and there is always a way round
    29,                         // Hole: walkable, and you fall through it
    48, 49,                     // ice: you slide, so a step is not a step
    44, 45, 46, 47,             // arrow floors: movement is not ours to choose
    60, 61, 62, 63, 64,         // spinners: same
]);

//  id -> the edge of its own tile that is closed, per the 68-75 legend. The
//  barrier blocks BOTH directions across that edge, so it is checked from
//  either side.
const EDGE_BLOCKS = {
    68: ["up"], 69: ["down"], 70: ["right"], 71: ["left"],
    72: ["up", "right"], 73: ["up", "left"],
    74: ["down", "right"], 75: ["down", "left"],
};

const STEPS = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
};
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };

function isWalkable(id) {
    if (id == null) return false;                       // fog of war
    if (SPECIAL_BLOCKED.has(id)) return false;
    if (EDGE_BLOCKS[id]) return true;                   // walkable, edges handled separately
    const entry = MARKDOWN_TILES[id];
    if (!entry) return false;                           // unknown id: do not guess
    return !entry[1].includes("(Collision)");
}

/**
 * Reads a tile in absolute map coordinates, preferring the live visible-area
 * grid over the remembered minimap -- the same precedence minimapToMarkdown
 * uses, so the path is planned against exactly what the model is shown.
 */
function makeTileReader(gameDataJson) {
    const minimapGrid = gameDataJson?.minimap_data?.grid;
    const areaGrid = gameDataJson?.game_area_meta_tiles;
    const px = Number(gameDataJson?.current_trainer_data?.position?.x);
    const py = Number(gameDataJson?.current_trainer_data?.position?.y);

    const areaH = Array.isArray(areaGrid) ? areaGrid.length : 0;
    const areaW = areaH > 0 && Array.isArray(areaGrid[0]) ? areaGrid[0].length : 0;
    const origin = gameDataJson?.visible_area_data?.origin || null;

    //  Where the player sits inside the visible grid. Prefer the origin the
    //  frame came with; fall back to the centre, which is where the window is
    //  built around the player anyway.
    let localRow = Number(py) - Number(origin?.y);
    let localCol = Number(px) - Number(origin?.x);
    if (!Number.isFinite(localRow) || localRow < 0 || localRow >= areaH) {
        localRow = areaH ? Math.floor(areaH / 2) : 0;
    }
    if (!Number.isFinite(localCol) || localCol < 0 || localCol >= areaW) {
        localCol = areaW ? Math.floor(areaW / 2) : 0;
    }

    return function tileAt(x, y) {
        const row = localRow + (y - py);
        const col = localCol + (x - px);
        if (areaH && row >= 0 && row < areaH && col >= 0 && col < areaW) {
            const id = areaGrid[row][col];
            if (id != null) return id;
        }
        if (Array.isArray(minimapGrid)) {
            const id = minimapGrid[y]?.[x];
            if (id != null) return id;
        }
        return null;
    };
}

//  An edge is open only if neither of the two tiles it separates closes it.
function edgeOpen(tileAt, x, y, dir) {
    const here = EDGE_BLOCKS[tileAt(x, y)];
    if (here && here.includes(dir)) return false;
    const [dx, dy] = STEPS[dir];
    const there = EDGE_BLOCKS[tileAt(x + dx, y + dy)];
    if (there && there.includes(OPPOSITE[dir])) return false;
    return true;
}

/**
 * Breadth-first search from the player to (targetX, targetY).
 * @returns {{keys: string[], explanation: string}}
 * @throws  {Error} with a reason the model can act on.
 */
function planPath(gameDataJson, targetX, targetY) {
    const pos = gameDataJson?.current_trainer_data?.position || {};
    const startX = Number(pos.x);
    const startY = Number(pos.y);
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) {
        throw new Error("Player position unavailable; cannot plan a path.");
    }
    if (startX === targetX && startY === targetY) {
        return { keys: [], explanation: "Already standing on the target tile." };
    }

    const tileAt = makeTileReader(gameDataJson);

    //  The destination is allowed to be solid: walking INTO a door, an NPC or
    //  a bookshelf is how you use it. So we path to the last free tile and let
    //  the caller's own step bump into it.
    const targetId = tileAt(targetX, targetY);
    const targetSolid = !isWalkable(targetId);

    const key = (x, y) => x + "," + y;
    const cameFrom = new Map([[key(startX, startY), null]]);
    let queue = [[startX, startY]];
    let found = null;

    while (queue.length && !found) {
        const next = [];
        for (const [x, y] of queue) {
            for (const dir of ["up", "down", "left", "right"]) {
                const [dx, dy] = STEPS[dir];
                const nx = x + dx, ny = y + dy;
                const k = key(nx, ny);
                if (cameFrom.has(k)) continue;
                if (!edgeOpen(tileAt, x, y, dir)) continue;

                const arrived = nx === targetX && ny === targetY;
                //  A solid destination is reachable but not enterable: record
                //  the arrival and stop, without queueing it for expansion.
                if (arrived && targetSolid) {
                    cameFrom.set(k, { x, y, dir });
                    found = [nx, ny];
                    break;
                }
                if (!isWalkable(tileAt(nx, ny))) continue;
                cameFrom.set(k, { x, y, dir });
                if (arrived) { found = [nx, ny]; break; }
                next.push([nx, ny]);
            }
            if (found) break;
        }
        queue = next;
    }

    if (!found) {
        const what = targetId == null
            ? "that tile is unexplored (fog of war)"
            : `that tile reads as ${(MARKDOWN_TILES[targetId] || ["?", "an unknown tile"])[1]}`;
        throw new Error(
            `No walkable route from (${startX}, ${startY}) to (${targetX}, ${targetY}): ${what}, `
            + "or every route to it is blocked. Ledges, water, ice and spinner tiles are not "
            + "used for routing -- walk those manually with key_press."
        );
    }

    const keys = [];
    let cur = key(found[0], found[1]);
    while (cameFrom.get(cur)) {
        const step = cameFrom.get(cur);
        keys.push(step.dir);
        cur = key(step.x, step.y);
    }
    keys.reverse();

    return {
        keys,
        explanation:
            `Local BFS: ${keys.length} step${keys.length === 1 ? "" : "s"} from `
            + `(${startX}, ${startY}) to (${targetX}, ${targetY})`
            + (targetSolid ? ", ending by walking into the target tile." : "."),
    };
}

module.exports = { planPath, isWalkable };
