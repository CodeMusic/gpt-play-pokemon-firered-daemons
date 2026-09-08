const {
    MARKDOWN_TILES,
    PLAYER_ORIENTATION_TILES,
    FALLBACK,
    SYM_PLAYER,
    SYM_UNKNOWN,
    NPC_ID,
} = require('../constants/tiles');
const { state } = require('../state/stateManager');

const mdRow = (cells) => `| ${cells.join("|")} |`;
const mdSep = (n) => `| ${Array(n).fill("---").join("|")} |`;


/**
 * Convertit la grille « visible » (9×10 méta‑tuiles) en Markdown.
 * @param {number[][]} grid   tableau 2‑D d'ID de méta‑tuile
 * @param {number}     px     coordonnée monde X du joueur
 * @param {number}     py     coordonnée monde Y du joueur
 * @param {number}     map_id Current map ID
 * @param {string}     map_name Current map name
 * @param {number}     map_height Current map height
 * @param {number}     map_width Current map width
 */
function gameAreaToMarkdown(
    grid,
    px,
    py,
    map_id,
    map_name,
    map_height,
    map_width,
    originX = null,
    originY = null,
    playerOrientationId = null,
    npcEntries = null
) {
    if (!Array.isArray(grid) || !grid.length) return "## Visible Game Area\n_Aucune donnée_\n";

    const H = grid.length, W = grid[0].length;
    const hasOrigin = Number.isFinite(originX) && Number.isFinite(originY);

    // Legacy format assumed a centered player at (4,4) for a 9x10 grid.
    // FireRed provides `originX/originY`, so we can compute world coords per cell without changing markdown format.
    const defaultLocalRow = 4;
    const defaultLocalCol = 4;
    const computedLocalRow = hasOrigin && Number.isFinite(py) ? py - originY : defaultLocalRow;
    const computedLocalCol = hasOrigin && Number.isFinite(px) ? px - originX : defaultLocalCol;
    const localRow = Number.isFinite(computedLocalRow) && computedLocalRow >= 0 && computedLocalRow < H ? computedLocalRow : defaultLocalRow;
    const localCol = Number.isFinite(computedLocalCol) && computedLocalCol >= 0 && computedLocalCol < W ? computedLocalCol : defaultLocalCol;

    const worldXAt = (c) => (hasOrigin ? originX + c : px + (c - localCol));
    const worldYAt = (r) => (hasOrigin ? originY + r : py + (r - localRow));

    const header = [" Y \\ X ", ...Array(W).fill().map((_, c) => String(worldXAt(c)))];
    const out = [
        `## Visible Game Area (${H}x${W} Meta‑Tiles)`,
        `This represents what you see right now in the game screenshot.`,
        `This shows only the visible area, not the entire map. You can see only ${H}x${W} tiles at a time.`,
        `Refer to "explored_map" for the entire map.`,
        `Player Position (Map Coords): X=${px}, Y=${py}`,
        `Map Name: ${map_name}`,
        `Map Size: ${map_width}x${map_height}\n`,
        mdRow(header),
        mdSep(header.length),
    ];


    // --- Marker Duplicate Handling (copié de minimapToMarkdown) ---
    const mapMarkers = state.markers[map_id] || {};
    const emojiCounts = {};
    const markerLocations = {}; // { 'x_y': {emoji, label} }
    // On ne compte que les markers visibles dans la zone 9x10
    for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
            const worldX = worldXAt(c);
            const worldY = worldYAt(r);
            const markerKey = `${worldX}_${worldY}`;
            const marker = mapMarkers[markerKey];
            if (marker) {
                emojiCounts[marker.emoji] = (emojiCounts[marker.emoji] || 0) + 1;
                markerLocations[markerKey] = marker;
            }
        }
    }
    const duplicateEmojis = new Set(Object.keys(emojiCounts).filter(emoji => emojiCounts[emoji] > 1));
    const numberedMarkerSymbols = {}; // { 'x_y': 'emoji[index]' }
    const emojiCurrentIndex = {}; // { 'emoji': last_index_used }
    // Assign indices to duplicate markers (dans l'ordre des positions)
    const sortedMarkerKeys = Object.keys(markerLocations).sort();
    for (const key of sortedMarkerKeys) {
        const marker = markerLocations[key];
        if (duplicateEmojis.has(marker.emoji)) {
            emojiCurrentIndex[marker.emoji] = (emojiCurrentIndex[marker.emoji] || 0) + 1;
            numberedMarkerSymbols[key] = `${marker.emoji}[${emojiCurrentIndex[marker.emoji]}]`;
        }
    }
    // --- Fin gestion des doublons ---

    // 1) Tableau
    const uniqueValues = new Set(grid.flat()); // Get unique tile IDs from the visible area
    const visibleMarkers = new Map(); // Store visible markers for the legend { emoji ou emoji[index]: {label, x, y} }
    const tileIdByCoord = new Map(); // { 'x_y': tileId } for the visible area

    for (let r = 0; r < H; r++) {
        const worldY = worldYAt(r);
        const row = [`${worldY}`];
        for (let c = 0; c < W; c++) {
            const worldX = worldXAt(c);
            const id = grid[r][c];
            const baseSymb = (MARKDOWN_TILES[id] || FALLBACK)[0]; // Get base tile symbol first
            const isPlayerTile = Number(worldX) === Number(px) && Number(worldY) === Number(py);
            const playerSymb =
                playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId]
                    ? PLAYER_ORIENTATION_TILES[playerOrientationId][0]
                    : SYM_PLAYER[0];

            // Check for marker
            const markerKey = `${worldX}_${worldY}`;
            tileIdByCoord.set(markerKey, id);
            const marker = mapMarkers[markerKey];
            let markerSymbol = "";
            if (marker) {
                if (numberedMarkerSymbols[markerKey]) {
                    markerSymbol = numberedMarkerSymbols[markerKey];
                } else {
                    markerSymbol = marker.emoji;
                }
                // Utiliser le symbole unique (plain ou indexé) comme clé pour visibleMarkers
                if (!visibleMarkers.has(markerSymbol)) {
                    visibleMarkers.set(markerSymbol, { label: marker.label, x: worldX, y: worldY });
                }
            }

            // IMPORTANT: do not replace the underlying tile with the player symbol.
            // We append the player's orientation glyph so the tile remains visible.
            const symb = `${baseSymb}${isPlayerTile ? playerSymb : ""}${markerSymbol}`;
            const cellText = `${symb} (${worldX}x${worldY})`;
            row.push(cellText);
        }
        out.push(mdRow(row));
    }

    // 2) Légende
    const legendSeen = new Set();
    const customMarkerLegendLines = ["\n### Custom Markers (Visible) - Markers set with the 'add_marker' tool"];
    const npcLegendLines = ["\n### NPCs (Visible Area)"];
    const mapLegendLines = ["\n### Map Legend (Visible Area)"];

    // Add visible custom markers to their legend (avec indexation)
    // Trier les clés pour l'ordre d'affichage
    const sortedVisibleMarkerKeys = [...visibleMarkers.keys()].sort();
    for (const markerSymbol of sortedVisibleMarkerKeys) {
        const markerData = visibleMarkers.get(markerSymbol);
        const { label, x: markerX, y: markerY } = markerData;
        const legendText = `${label} (${markerX}x${markerY}) (Custom Marker)`;
        customMarkerLegendLines.push(`- ${markerSymbol} : ${legendText}`);
    }

    // NPC list (position -> name) for the visible area.
    // We only include NPCs that are currently represented as the generic NPC tile (👤) on the grid.
    if (Array.isArray(npcEntries) && npcEntries.length > 0) {
        const npcsInArea = [];
        for (const npc of npcEntries) {
            if (!npc || typeof npc !== "object") continue;
            if (npc.isActive === false) continue;

            const xRaw = Number.isFinite(Number(npc.x))
                ? Number(npc.x)
                : Array.isArray(npc.position)
                    ? Number(npc.position[0])
                    : NaN;
            const yRaw = Number.isFinite(Number(npc.y))
                ? Number(npc.y)
                : Array.isArray(npc.position)
                    ? Number(npc.position[1])
                    : NaN;
            if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) continue;

            const key = `${xRaw}_${yRaw}`;
            if (!tileIdByCoord.has(key)) continue;
            if (tileIdByCoord.get(key) !== NPC_ID) continue;

            const name = typeof npc.type === "string" ? npc.type : typeof npc.name === "string" ? npc.name : "UNKNOWN";
            const localId = Number.isFinite(Number(npc.localId)) ? Number(npc.localId) : null;
            const elevation = Number.isFinite(Number(npc.elevation)) ? Number(npc.elevation) : null;
            npcsInArea.push({ x: xRaw, y: yRaw, name, localId, elevation });
        }

        npcsInArea.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
        for (const npc of npcsInArea) {
            npcLegendLines.push(`- (${npc.x}x${npc.y}) : ${npc.name}`);
        }
    }

    // Player legend entry (use orientation symbol like explored_map).
    const [playerLegendSymb, playerLegendDesc] =
        playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId]
            ? PLAYER_ORIENTATION_TILES[playerOrientationId]
            : SYM_PLAYER;
    if (!legendSeen.has(playerLegendDesc)) {
        mapLegendLines.push(`- ${playerLegendSymb} : ${playerLegendDesc}`);
        legendSeen.add(playerLegendDesc);
    }

    // Add every tile ID actually visible (including NPC-specific IDs), sorted
    const visibleIds = [...uniqueValues].sort((a, b) => a - b);
    const allDefinedIds = new Set(Object.keys(MARKDOWN_TILES).map(Number));
    let unknownPresent = false;

    for (const id of visibleIds) {
        if (allDefinedIds.has(id)) {
            const [symb, desc] = MARKDOWN_TILES[id] || FALLBACK;
            if (!legendSeen.has(desc)) {
                mapLegendLines.push(`- ${symb} : ${desc}`);
                legendSeen.add(desc);
            }
        } else {
            unknownPresent = true;
        }
    }

    // If any visible tile is not defined, add a fallback legend entry
    if (unknownPresent) {
        const [symb, desc] = FALLBACK;
        if (!legendSeen.has(desc)) {
            mapLegendLines.push(`- ${symb} : ${desc}`);
            legendSeen.add(desc);
        }
    }

    // Append legends if they have content
    if (customMarkerLegendLines.length > 1) {
        out.push(...customMarkerLegendLines);
    }
    if (npcLegendLines.length > 1) {
        out.push(...npcLegendLines);
    }
    if (mapLegendLines.length > 1) {
        out.push(...mapLegendLines);
    }

    return out.join("\n");
}

/**
 * Convertit la minimap complète (JSON) en Markdown.
 * @param {{width:number,height:number,grid:number[][]}} mm
 * @param {number}     px     coordonnée monde X du joueur
 * @param {number}     py     coordonnée monde Y du joueur
 * @param {number}     map_id Current map ID
 * @param {string}     map_name Current map name
 * @param {number|null} playerOrientationId Player orientation tile ID (100-103) or null
 * @param {number[][]} gameAreaGrid The grid data from the visible game area (e.g., 9x10)
 * @param {number}     gameAreaLocalPlayerRow Player's row index within gameAreaGrid (e.g., 4)
 * @param {number}     gameAreaLocalPlayerCol Player's column index within gameAreaGrid (e.g., 4)
 * @param {boolean}    isPathFinding Whether this is a pathfinding request
 */
//  DAEMONS: name the exits, because nothing else does.
//
//  The legend says "🧗 : Stairs" and the grid puts one at (9,2), and the model
//  wandered the room for an hour anyway. Knowing a staircase is a staircase is
//  not the same as knowing it is the way OUT -- that inference was left to
//  14,810 tokens of general instruction, and it did not survive the trip.
//
//  Every id here is already labelled in constants/tiles.js, so this is a read
//  of data we ship anyway. It costs about twenty tokens and it answers the
//  question the run kept failing: where is the door.
const EXIT_TILES = {
    9: "warp", 26: "door", 27: "ladder", 28: "escalator",
    30: "stairs", 31: "entrance", 32: "warp arrow",
    //  23 is the red exit carpet, and leaving it out was a real bug: on the
    //  ground floor of the house the ONLY thing this listed was "stairs at
    //  (11,2)" -- the stairs back UP. The carpet is the door to the town.
    //  markdownFormatter's own legend already says so: "When you see a 🟥 exit
    //  carpet, you can walk through it to exit the map."
    23: "exit carpet",
};

//  Stairs, ladders and escalators move you between floors of the SAME
//  building. Doors, entrances and warps lead somewhere else, usually outside.
//  Listing all of them undifferentiated is what sent the agent back up the
//  stairs it had just come down: on the ground floor it read
//    "exit carpet at (10, 2), stairs at (11, 2), exit carpet at (4, 8),
//     door at (4, 9)"
//  and walked at the stairs, which are the way BACK.
const FLOOR_CHANGE = new Set(["stairs", "ladder", "escalator"]);

//  Outdoors there are no exit TILES -- you leave a town or a route by walking
//  off the edge. The legend has always said so: "Negative coordinates or out of
//  bounds coordinates (OOB Tiles) walkable mean a map transition!" A
//  tile-only reader reports "none discovered yet" on every outdoor map, which
//  is worse than saying nothing, because it is confidently wrong.
//
//  Tile 24 is "OOB (Walkable)" and 25 is "OOB (Collision)" -- so a walkable OOB
//  tile IS the way out. They come in runs along an edge, so they are collapsed
//  to one entry per side rather than listing forty coordinates.
const OOB_WALKABLE = 24;

function edgeExits(grid) {
    const sides = { north: [], south: [], west: [], east: [] };
    const h = grid.length, w = grid[0].length;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < grid[y].length; x++) {
            if (grid[y][x] !== OOB_WALKABLE) continue;
            if (y <= 0) sides.north.push(x);
            else if (y >= h - 1) sides.south.push(x);
            else if (x <= 0) sides.west.push(y);
            else if (x >= w - 1) sides.east.push(y);
        }
    }
    const out = [];
    for (const [side, hits] of Object.entries(sides)) {
        if (!hits.length) continue;
        const mid = hits[Math.floor(hits.length / 2)];
        const at = (side === "north" || side === "south") ? `x=${mid}` : `y=${mid}`;
        out.push(`walk off the ${side.toUpperCase()} edge (around ${at})`);
    }
    return out;
}

//  Say which WAY, not just where.
//
//  The prompt states "Y increases ↓" and never says which key changes it.
//  Knowing the axis points down and knowing that `up` decreases y are two
//  different facts, and only the first was ever written down. From (11, 8),
//  aiming at stairs at (9, 2), it pressed DOWN into the bottom wall for
//  twenty-two turns.
//
//  So the bearing is computed rather than left as arithmetic. The direction
//  words come from the same mapping the BFS uses -- up is -y, down is +y --
//  so this cannot disagree with the pathfinder that has to execute it.
function bearing(fromX, fromY, x, y) {
    if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return "";
    const dx = x - fromX, dy = y - fromY;
    const parts = [];
    if (dy < 0) parts.push(`${-dy} UP`);
    if (dy > 0) parts.push(`${dy} DOWN`);
    if (dx < 0) parts.push(`${-dx} LEFT`);
    if (dx > 0) parts.push(`${dx} RIGHT`);
    if (!parts.length) return " -- you are standing on it";
    return ` -- ${parts.join(" and ")} from you`;
}

//  A warp carpet beside a staircase belongs to the staircase.
//
//  On 2F the carpet at (10, 2) sits next to the stairs at (9, 2) and takes you
//  DOWN A FLOOR. Listed under "to LEAVE this building" it produced the
//  objective "use the exit carpet at (10, 2) to reach the town", so the agent
//  warped downstairs expecting Blanche Town. The real house exit is on 1F --
//  carpet (4, 8) beside door (4, 9) -- and has no stairs next to it.
//
//  Adjacency is read from the grid rather than asserted, and it agrees with
//  both observed floors. Where a warp actually goes is still not knowable from
//  a tile, so the headings say "probably" and stop claiming certainty -- this
//  line has now been wrong four times, every one of them me stating what an
//  exit IS rather than what the grid SAYS.
const FLOOR_ID = new Set([27, 28, 30]);   // ladder, escalator, stairs

function besideFloorChange(grid, x, y) {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const row = grid[y + dy];
        if (row && FLOOR_ID.has(row[x + dx])) return true;
    }
    return false;
}

//  A MAP CONNECTION IS NOT A DOOR, and nothing was telling the agent they
//  exist.
//
//  Blanche Town connects `up` to ROUTE1. That fact sits in game_data.json on
//  every single step -- and the string "ROUTE1" appeared ZERO times in the
//  prompt the agent actually received. Every exit it was told about was a
//  building door, so it hunted the town for a door to the north that has
//  never existed: you leave by walking off the top edge.
//
//  The prompt even carried a rule about how to MARK a map connection while
//  never mentioning that this map has one.
const CONNECTION_WORDS = {
    up:    ["NORTH", "walk UP off the top edge"],
    down:  ["SOUTH", "walk DOWN off the bottom edge"],
    left:  ["WEST",  "walk LEFT off the left edge"],
    right: ["EAST",  "walk RIGHT off the right edge"],
};

function connectionsLine(connections) {
    if (!Array.isArray(connections)) return null;
    const real = connections.filter(
        (c) => c && c.mapName && c.mapName !== "MAP_NONE" && CONNECTION_WORDS[c.direction]
    );
    if (!real.length) return null;
    const named = real.map((c) => {
        const [compass, how] = CONNECTION_WORDS[c.direction];
        return `${compass} to ${c.mapName} -- ${how}`;
    });
    return "**Leaves this map WITHOUT a door** (walk off the map edge, there is "
        + `no door and no carpet): ${named.join("; ")}.`;
}

function exitsLine(grid, playerX, playerY, connections = null) {
    if (!Array.isArray(grid) || !Array.isArray(grid[0])) return null;
    const out = [], floors = [];
    for (let y = 0; y < grid.length; y++) {
        for (let x = 0; x < grid[y].length; x++) {
            const kind = EXIT_TILES[grid[y][x]];
            if (!kind) continue;
            const entry = `${kind} at (${x}, ${y})${bearing(playerX, playerY, x, y)}`;
            const isFloor = FLOOR_CHANGE.has(kind)
                || (kind === "exit carpet" && besideFloorChange(grid, x, y));
            (isFloor ? floors : out).push(entry);
        }
    }
    out.push(...edgeExits(grid));
    if (!out.length && !floors.length && !connectionsLine(connections)) {
        return "**Exits on this map:** none discovered yet -- explore toward the ❓ tiles to find one.";
    }
    const parts = [];
    const conn = connectionsLine(connections);
    //  Before the door list, deliberately: an agent circling a town looking
    //  for a door needs to read "there is no door, walk off the edge" first.
    if (conn) parts.push(conn);
    if (out.length) {
        parts.push(`**Probably leads OUT of this building/area:** ${out.join(", ")}.`);
    }
    if (floors.length) {
        parts.push(`**Goes to another FLOOR of this same building, not outside:** ${floors.join(", ")}.`);
    }
    //  ...and "no way out" is wrong again when the map has an EDGE connection,
    //  for the same reason it was wrong on a staircase floor: the exit is real,
    //  it just is not a door. The first version of this printed both -- two
    //  named routes out, followed by "no way out discovered yet" -- which
    //  contradicts itself in the same breath and is worse than either alone.
    if (!out.length && !conn) {
        //  "No way out" is wrong when there is a staircase: on 2F the exit is
        //  real, it is just one floor down. Saying "explore the ❓ tiles" there
        //  would send it hunting a door that does not exist on this floor.
        parts.push(floors.length
            ? "There is NO exit to the outside on this floor -- take one of the above to"
              + " another floor first, then look for a door or carpet there."
            : "No way out discovered yet -- explore toward the ❓ tiles.");
    }
    return parts.join(" ");
}

function minimapToMarkdown(mm, minimapPlayerX, minimapPlayerY, map_id, map_name, playerOrientationId, gameAreaGrid, gameAreaLocalPlayerRow, gameAreaLocalPlayerCol, npcEntries = null, isPathFinding = false, connections = null) {
    if (!mm || !mm.grid) return "## Explored Map State\n_Aucune donnée_\n";

    const minimapGrid = mm.grid;
    const inferredH = Array.isArray(minimapGrid) ? minimapGrid.length : 0;
    const inferredW = inferredH > 0 && Array.isArray(minimapGrid[0]) ? minimapGrid[0].length : 0;
    const W = Number.isFinite(Number(mm.width)) ? Number(mm.width) : inferredW;
    const H = Number.isFinite(Number(mm.height)) ? Number(mm.height) : inferredH;
    const header = [" Y \ X ", ...Array(W).fill().map((_, x) => String(x))];

    // Determine gameAreaGrid dimensions safely
    const gameAreaHeight = Array.isArray(gameAreaGrid) ? gameAreaGrid.length : 0;
    const gameAreaWidth = gameAreaHeight > 0 && Array.isArray(gameAreaGrid[0]) ? gameAreaGrid[0].length : 0;

    // --- Marker Duplicate Handling ---
    const mapMarkers = state.markers[map_id] || {};
    const emojiCounts = {};
    const markerLocations = {}; // { 'x_y': {emoji, label} }
    for (const key in mapMarkers) {
        const marker = mapMarkers[key];
        emojiCounts[marker.emoji] = (emojiCounts[marker.emoji] || 0) + 1;
        markerLocations[key] = marker; // Store marker data by location key
    }
    const duplicateEmojis = new Set(Object.keys(emojiCounts).filter(emoji => emojiCounts[emoji] > 1));
    const numberedMarkerSymbols = {}; // { 'x_y': 'emoji[index]' }
    const emojiCurrentIndex = {}; // { 'emoji': last_index_used }

    // Assign indices to duplicate markers
    // Sort keys for consistent indexing (optional but good practice)
    const sortedMarkerKeys = Object.keys(markerLocations).sort();
    for (const key of sortedMarkerKeys) {
        const marker = markerLocations[key];
        if (duplicateEmojis.has(marker.emoji)) {
            emojiCurrentIndex[marker.emoji] = (emojiCurrentIndex[marker.emoji] || 0) + 1;
            numberedMarkerSymbols[key] = `${marker.emoji}[${emojiCurrentIndex[marker.emoji]}]`;
        }
    }
    // --- End Marker Duplicate Handling ---


    const out = [
        "## Current Map State",
        `This is the layout of the current map, filled in while exploring.`,
        `Every '❓' represents tiles you haven't explored yet. You need to explore them to discover doors, stairs, etc. Otherwise they won't appear on the map.`,
        `Player Position (Map Coords): X=${minimapPlayerX}, Y=${minimapPlayerY}`,
        `Map Name: ${map_name}`,
        `Map Size: ${W}x${H}`,
        exitsLine(minimapGrid, minimapPlayerX, minimapPlayerY, connections) || "",
        "",
        mdRow(header),
        mdSep(header.length),
    ];

    // 1) Tableau
    const uniqueValues = new Set(); // For the map legend
    let hasUnexplored = false;
    let haveBoulders = false; // Boulder puzzle hinting
    let haveTeleporters = false; // Warp/teleporter hinting
    let haveIceTiles = false; // Thin/Cracked ice hinting
    let haveSpinners = false; // Spinner tiles hinting
    let haveDirectionalBlockedGround = false; // One-way edge collision on walkable ground
    const visibleMarkers = new Map(); // Store markers visible on the minimap { 'emoji' or 'emoji[index]': {label, x, y} }

    for (let y = 0; y < H; y++) {
        const row = [`${y}`];
        for (let x = 0; x < W; x++) {
            // Calculate offset from player's *world* position (which is minimapPlayerX/Y)
            const deltaX = x - minimapPlayerX;
            const deltaY = y - minimapPlayerY;

            // Calculate corresponding *local* coordinates within gameAreaGrid
            const gameAreaRow = gameAreaLocalPlayerRow + deltaY;
            const gameAreaCol = gameAreaLocalPlayerCol + deltaX;

            let id; // Tile ID to use for symbol determination

            // Check if this minimap coordinate (x, y) is within the bounds of the visible gameAreaGrid
            if (gameAreaGrid &&
                gameAreaRow >= 0 && gameAreaRow < gameAreaHeight &&
                gameAreaCol >= 0 && gameAreaCol < gameAreaWidth) {
                id = gameAreaGrid[gameAreaRow][gameAreaCol];
                if (id != null) {
                    uniqueValues.add(id);
                }
            } else {
                id = minimapGrid[y]?.[x];
                if (id == null) {
                    hasUnexplored = true;
                } else {
                    uniqueValues.add(id);
                }
            }

            if (id === 33) {
                haveBoulders = true;
            }
            if (id === 9 || id === 32) {
                haveTeleporters = true;
            }
            if (id === 48 || id === 49) {
                haveIceTiles = true;
            }
            if (id >= 60 && id <= 64) {
                haveSpinners = true;
            }
            if (id >= 68 && id <= 75) {
                haveDirectionalBlockedGround = true;
            }

            let symb;
            let originalSymb;

            if (x === minimapPlayerX && y === minimapPlayerY) {
                originalSymb = (playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId])
                    ? PLAYER_ORIENTATION_TILES[playerOrientationId][0]
                    : SYM_PLAYER[0];
            } else if (id == null) {
                originalSymb = SYM_UNKNOWN[0];
            } else {
                originalSymb = (MARKDOWN_TILES[id] || FALLBACK)[0];
            }

            const markerKey = `${x}_${y}`;
            const marker = mapMarkers[markerKey];
            let markerSymbol = "";

            if (marker) {
                markerSymbol = numberedMarkerSymbols[markerKey] || marker.emoji;
                symb = originalSymb + markerSymbol;
                if (!visibleMarkers.has(markerSymbol)) {
                    visibleMarkers.set(markerSymbol, { label: marker.label, x: x, y: y });
                }
            } else {
                symb = originalSymb;
            }

            row.push(`${symb}${x}x${y}`);
        }
        out.push(mdRow(row));
    }

    // 2) Légende
    const legendSeen = new Set();
    const customMarkerLegendLines = ["\n### Custom Markers (Minimap) - Markers set with the 'add_marker' tool"];
    const npcLegendLines = ["\n### NPCs (Explored Map)"];
    const mapLegendLines = ["\n### Legend (Explored Map)"];

    // Add visible custom markers to their legend
    // Sort the marker keys (symbols) for consistent legend order
    const sortedVisibleMarkerKeys = [...visibleMarkers.keys()].sort();

    for (const markerSymbol of sortedVisibleMarkerKeys) { // Iterate using the unique symbol (plain or numbered)
        const markerData = visibleMarkers.get(markerSymbol);
        const { label, x: markerX, y: markerY } = markerData; // Use coords from markerData
        const legendText = `${label} (${markerX}x${markerY}) (Custom Marker)`;
        // Legend entry uses the markerSymbol (which might be indexed)
        customMarkerLegendLines.push(`- ${markerSymbol} : ${legendText}`);
        // No need for legendSeen check here as markerSymbol keys are unique
    }

    // NPC list (position -> name) for the explored map.
    // Only include NPCs that are represented as the generic NPC tile (👤) in the minimap display.
    const displayedTileIdAt = (x, y) => {
        const deltaX = x - minimapPlayerX;
        const deltaY = y - minimapPlayerY;
        const gameAreaRow = gameAreaLocalPlayerRow + deltaY;
        const gameAreaCol = gameAreaLocalPlayerCol + deltaX;

        if (gameAreaGrid &&
            gameAreaRow >= 0 && gameAreaRow < gameAreaHeight &&
            gameAreaCol >= 0 && gameAreaCol < gameAreaWidth) {
            return gameAreaGrid[gameAreaRow]?.[gameAreaCol];
        }
        return minimapGrid[y]?.[x];
    };

    if (Array.isArray(npcEntries) && npcEntries.length > 0) {
        const npcsOnMap = [];
        for (const npc of npcEntries) {
            if (!npc || typeof npc !== "object") continue;
            if (npc.isActive === false) continue;

            const xRaw = Number.isFinite(Number(npc.x))
                ? Number(npc.x)
                : Array.isArray(npc.position)
                    ? Number(npc.position[0])
                    : NaN;
            const yRaw = Number.isFinite(Number(npc.y))
                ? Number(npc.y)
                : Array.isArray(npc.position)
                    ? Number(npc.position[1])
                    : NaN;
            if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) continue;
            if (xRaw < 0 || xRaw >= W || yRaw < 0 || yRaw >= H) continue;

            if (displayedTileIdAt(xRaw, yRaw) !== NPC_ID) continue;

            const name = typeof npc.type === "string" ? npc.type : typeof npc.name === "string" ? npc.name : "UNKNOWN";
            const localId = Number.isFinite(Number(npc.localId)) ? Number(npc.localId) : null;
            const elevation = Number.isFinite(Number(npc.elevation)) ? Number(npc.elevation) : null;
            npcsOnMap.push({ x: xRaw, y: yRaw, name, localId, elevation });
        }

        npcsOnMap.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
        for (const npc of npcsOnMap) {
            npcLegendLines.push(`- (${npc.x}x${npc.y}) : ${npc.name}`);
        }
    }

    // Collect important transitions without custom markers
    // (door / ladder / escalator / stairs / entrance / warp)
    const doorLadderIds = new Set([26, 27, 28, 30, 31, 32]);
    const doorsLaddersWithoutMarkers = [];

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            // Calculate offset from player's world position
            const deltaX = x - minimapPlayerX;
            const deltaY = y - minimapPlayerY;
            const gameAreaRow = gameAreaLocalPlayerRow + deltaY;
            const gameAreaCol = gameAreaLocalPlayerCol + deltaX;

            let id;
            // Check if this coordinate is within the visible game area
            if (gameAreaGrid &&
                gameAreaRow >= 0 && gameAreaRow < gameAreaHeight &&
                gameAreaCol >= 0 && gameAreaCol < gameAreaWidth) {
                id = gameAreaGrid[gameAreaRow][gameAreaCol];
            } else {
                id = minimapGrid[y]?.[x];
            }

            // Check if this tile is a door/ladder and doesn't have a custom marker
            if (id != null && doorLadderIds.has(id)) {
                const markerKey = `${x}_${y}`;
                const hasMarker = mapMarkers[markerKey];

                if (!hasMarker) {
                    const [symb, desc] = MARKDOWN_TILES[id] || FALLBACK;
                    doorsLaddersWithoutMarkers.push({
                        x: x,
                        y: y,
                        symbol: symb,
                        description: desc
                    });
                }
            }
        }
    }

    // Create the doors/ladders without markers section
    const doorsLaddersLegendLines = [
        "\n### Doors / Ladders Without Custom Markers"
    ];
    if (doorsLaddersWithoutMarkers.length > 0) {
        doorsLaddersLegendLines.push("_These are doors, stairs, or ladders that do not have a custom marker placed directly on them. This usually means they are either unexplored, or a marker was placed in front of them instead of on the actual tile. Please check and place markers directly on the door, stairs, or ladder tile for accurate tracking, or visit them to set the needed marker._");
        // Sort by y then x for consistent ordering
        doorsLaddersWithoutMarkers.sort((a, b) => {
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });

        for (const item of doorsLaddersWithoutMarkers) {
            doorsLaddersLegendLines.push(`- ${item.symbol} : ${item.description} (${item.x}x${item.y})`);
        }
    }

    // Add Player symbol (with orientation) to map legend
    const [playerSymb, playerDesc] = (playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId])
        ? PLAYER_ORIENTATION_TILES[playerOrientationId]
        : SYM_PLAYER;
    mapLegendLines.push(`- ${playerSymb} : ${playerDesc}`);
    legendSeen.add(playerDesc);

    // Add Unexplored symbol if present
    if (hasUnexplored) {
        mapLegendLines.push(`- ${SYM_UNKNOWN[0]} : ${SYM_UNKNOWN[1]}`);
        legendSeen.add(SYM_UNKNOWN[1]);
    }

    // Add every unique tile value that appears on the explored minimap (including NPC-specific IDs)
    const visibleIds = Array.from(uniqueValues).sort((a, b) => a - b);
    const allDefinedIds = new Set(Object.keys(MARKDOWN_TILES).map(Number));
    let unknownPresent = false;

    for (const id of visibleIds) {
        if (allDefinedIds.has(id)) {
            const [symb, desc] = MARKDOWN_TILES[id] || FALLBACK;
            if (!legendSeen.has(desc)) {
                mapLegendLines.push(`- ${symb} : ${desc}`);
                legendSeen.add(desc);
            }
        } else {
            unknownPresent = true;
        }
    }

    // Add NPC fallback only if present
    if (visibleIds.includes(NPC_ID)) {
        const [symb, desc] = MARKDOWN_TILES[NPC_ID] || FALLBACK;
        if (!legendSeen.has(desc)) {
            mapLegendLines.push(`- ${symb} : ${desc}`);
            legendSeen.add(desc);
        }
    }

    // Add fallback for unknown tiles if any
    if (unknownPresent) {
        const [symb, desc] = FALLBACK;
        if (!legendSeen.has(desc)) {
            mapLegendLines.push(`- ${symb} : ${desc}`);
            legendSeen.add(desc);
        }
    }


    // Append legends if they have content
    if (customMarkerLegendLines.length > 1) {
        out.push(...customMarkerLegendLines);
    }

    if (npcLegendLines.length > 1) {
        out.push(...npcLegendLines);
    }

    // Add doors/ladders without markers section
    if (doorsLaddersLegendLines.length > 1) {
        out.push(...doorsLaddersLegendLines);
    }

    if (mapLegendLines.length > 1) {
        out.push(...mapLegendLines);
    }

    out.push("\n<navigation_notes>### Navigation Notes (Must read):\n");

    out.push("Custom markers have no collision, they are just markers you set during your journey. For the collision refer to the map legend.");

    if (hasUnexplored && !isPathFinding) {
        out.push(`
# Unexplored Areas ('❓' tiles) Guide

## What '❓' Tiles Are
'❓' tiles represent **areas of the map that you have not yet discovered**. They are not walls or obstacles—just unknown spaces. You uncover what's behind a '❓' tile by moving close enough that it comes into your **view range** (the visible area around your character), even if you do not step directly on the tile. It is very important to travel near the '❓' tiles—simply approaching them within your vision will automatically reveal what is beneath. Exploring is required to fully reveal the area; do not make assumptions about what lies behind '❓' tiles.

## Critical Rule: Hidden Elements
**ALL doors, stairs, ladders, and other interactive elements may be hidden behind '❓' tiles.** You cannot see these objects until the tiles near them come into your visible range through exploration. Even after you’ve found some doors, there may be more within unexplored regions.
**Explore EVERYTHING**—move close to every '❓' tile, even if you think it’s a dead end or isolated. Bonk into walls and check all corners; often, what you’re looking for is simply hidden behind an unexplored tile.

## Exploration Strategy
1. **Move near all nearby '❓' tiles first**—your goal is to bring each one into your view range so they’re revealed on your map.
2. **Check around discovered buildings and edges**—there are often '❓' tiles adjacent to explored regions, so scan those borders.
3. **Explore systematically**—when you see clusters of '❓' tiles, approach them steadily in one direction to minimize missed spots.
4. **Cities first**—when searching for specific buildings, always reveal ALL '❓' tiles within city areas before concluding nothing remains.
5. **Never assume**—do not rely on memory or logic to guess what’s behind a '❓' tile. Always verify by exploring; knowledge comes only after revealing the area.
6. **Don’t assume a '❓' tile is inaccessible until you try**—attempt to move near tiles using the 'key_press' tool to see if they can be reached and revealed; only consider them inaccessible if repeated attempts with both 'key_press' and 'path_to_location' fail.
7. **Always use the 'key_press' tool first when exploring '❓' tiles**; use 'path_to_location' as a last resort if you're truly blocked or the destination is far.
8. **Do not skip unexplored zones!** Make sure to reveal every '❓' tile you can; unexplored spots often hide important paths or objects.

## Navigation Tools
- **Use \`explored_map\` as your primary reference**—'❓' tiles are only shown here, not in your immediate vision.
- Use the **'path_to_location' tool** to automatically reach or get close to '❓' tiles when direct 'key_press' navigation is difficult.

## Key Reminders
- **You must bring '❓' tiles into your view—being nearby is enough to reveal them**.
- Do not declare an area complete or a building “missing” until you have gotten close enough to reveal ALL '❓' tiles on the map.
- **Avoid repeated pathing in already revealed areas; if you’re stuck or looping, look for unrevealed '❓' tiles to break the loop.**
- Prefer revealing by manual movement (with 'key_press'), but don’t hesitate to use 'path_to_location' if needed.
- *Your full understanding of the world requires exploring—don't make assumptions about the unknown!*

## IMPORTANT NOTES

- **Do not backtrack or assume a place is a dead end if you didn't explore all the '❓' tiles in the area.**
- **If you are not sure if you can reach a '❓' tile, use the 'path_to_location' tool to check if you can reach it. You can ask to the tool to find all the "reachable" '❓' tiles in the area.**
- **Never miss this step, this is important to "build" your minimap and to be sure to not miss a critical path!**

`);
    }

    // Spinner tiles are now explicit FireRed minimap codes (60..64), no special conversion needed here.
    if (!isPathFinding) {

        // Core navigation guidelines
        out.push(`
## Core Requirements

**Mark Defeated Trainers:** 
- Always add markers (💀) after trainer battles for progress tracking (Do not add a marker for the rival after you defeated him, because he is not stationary, when you defeat him he moving away from you).
- The defeated trainer will always be the one in front of you (The one you face after the battle), place the marker on the tile where the trainer is standing.

**🚨 CRITICAL - Entrance/Exit Protocol:**
1. **Test First:** Attempt to use any door/exit/stairs
2. **Confirm Connection:** Verify it leads to another location  
3. **🎯 MARK BOTH MAPS IMMEDIATELY:** Place clear markers on BOTH origin and destination - DO NOT SKIP THIS STEP
4. **Validation Check:** Review action history and delete false markers if uncertain
5. ${(process.env.DAEMONS_SCHEMA || "full") === "full" ? "**VERY IMPORTANT:MARKER PLACEMENT RULE:** Place markers directly ON doors/stairs tile, NOT in front of them. Fix them if you placed them in front of them! Always do a check and a fix before any action. You can't place a door/stairs/ladder marker in a 'Free Ground' tile, you must place it on the door/stairs/ladder tile." : "**Leaving a map:** use one of the exits named above the grid -- a door, stairs, a warp, or an exit carpet. On an exit carpet, step onto it and then press toward the adjacent wall; the warp fires on the blocked move, not on arriving."}

## Map Transition Discovery
**Hidden Warps:** Many transitions are invisible until discovered:
- **Map Edges:** Automatic warps at accessible boundaries (check collision data for passable edges at negative coordinates or beyond normal dimensions). Negative coordinates or out of bounds coordinates (OOB Tiles) walkable mean a map transition !
- **Hidden Entrances:** Buildings may have invisible rear entrances - test walls around buildings by walking directly into them (bump into building walls using left/right/up/down movement)
- **🟥 Exit Carpet:** When you see a 🟥 exit carpet, you can walk through it to exit the map. To trigger the exit warp, stand on the carpet and attempt to move in any direction (down/up/left/right) toward the nearest '⛔' tile. The exit functions like a collision tile - attempting to move while on the carpet will trigger the warp, similar to bumping into a wall.
- **Stairs:** When you use stairs, you're teleported to the corresponding staircase on another map, appearing directly on the stairs tile. However, if you're standing on a staircase tile, it means you've just arrived from the connected map. To use the same staircase again immediately, you must first step off and then step back onto the tile to trigger the warp again. This requirement only applies when trying to reuse stairs right after arriving. The warp is only triggered when you move onto the stairs tile from another tile - this prevents automatic warping upon arrival.


**Discovery Protocol:**
- When you find new ladders/doors/stairs, enter them immediately to create markers

## 🔥 MANDATORY MARKER REQUIREMENTS

**⚠️ AFTER EVERY MAP TRANSITION / TELEPORTER USAGE:**
1. **STOP and CHECK:** Did I place markers on both maps/teleporters?
2. **If NO:** Go back and add them immediately
3. **If UNSURE:** Check recent action history and verify

**🚨 EMERGENCY MARKER CHECK:**
- **Entered building/new area?** → Add markers NOW
- **Used door/stairs/exit?** → Add markers NOW  
- **Changed locations?** → Add markers NOW

**📍 Map Change Protocol:**
- Every time you change maps, FIRST action must be verifying all markers are placed correctly
- Fix any missing or incorrect markers immediately before continuing exploration

- **Mark Important NPC:** Always add markers for the important NPC you met (E.g: 🛒 Shop clerk, 💉 Nurse Joy, etc ...) DO NOT SKIP THIS STEP, you must remember the location of these NPCs for later use !

* Do not use emojis already reserved by the minimap system: ⛔, 🟫, 🟫↑🚫, 🟫↓🚫, 🟫→🚫, 🟫←🚫, 🟫↑→🚫, 🟫↑←🚫, 🟫↓→🚫, 🟫↓←🚫, 🌿, 🌊, 💧↑, ⛛→, ⛛←, ⛛↑, ⛛↓, 🌀, 👤, ✨, 🖥️, 🗺️, 📺, 📚, 🗑️, 🛒, 🟥, ⬜, ⬛, 🚪, 🚪🔒, 🪜, 🛗, 🕳️, 🧗, 🏔️, ➡️, 🪨, 🌳, 🪨⛏️, ←, →, ↑, ↓, 🧊, 🧊⚡, 🌊←, 🌊→, 🌊↑, 🌊↓, 🌊🫧, 🎁, 🌀→, 🌀←, 🌀↑, 🌀↓, 🌀⏹️, 🔘, 🧱⏳, 🟫⚡, 🧍↓, 🧍↑, 🧍←, 🧍→. All other emojis are accepted and can be reused multiple times for your custom markers.
* You can use the same emoji for multiple markers, as long as it is not a fixed marker from the legend.

- **Do not use "🚪" marker to mark a map connection, use emoji like "⬇️" or "⬆️" or "⬅️" or "➡️" to mark the direction of the connection. This rule is only for map connections / stairs / ladders in the overworld, not for buildings entrances.**
- **Use markers like "🏪", "🏠", "🛒", "🏥", etc. to mark doors / buildings entrances.**
- **Use arrows like "⬇️", "⬆️", "⬅️", "➡️" to mark red carpet tiles.**

    `);
    }
    if (haveTeleporters) {
        out.push(`
**Teleporter Mechanics:**
- You can **stand** on a teleporter by going through it (you will be teleported to another location) and then returning to it from the destination teleporter. This allows you to occupy the teleporter tile and explore hidden areas that may be accessible from that position (the teleporter will not activate if you're already standing on it when you move). This works like a "maze" - sometimes you must do this because the teleporter may block a pathway.
        `);
    }

    if (haveDirectionalBlockedGround) {
        out.push(`
### Directional Collision Ground (🟫…🚫) Mechanics

This map contains **walkable ground tiles with directional collision barriers**:
- **🟫↑🚫 / 🟫↓🚫 / 🟫→🚫 / 🟫←🚫**: collision barrier on one side
- **🟫↑→🚫 / 🟫↑←🚫 / 🟫↓→🚫 / 🟫↓←🚫**: collision barriers on two sides

These are **not full walls**: you can still stand on the tile itself. The arrow(s) indicate which side(s) of the tile have a **collision barrier**. This barrier **blocks movement in both directions** across that edge.

**Example:**
- Tile **31x14 = 🟫↑🚫** means: there is a collision barrier on the **north edge** of tile 31x14 (between 31x14 and 31x13). You cannot move **from 31x14 to 31x13** (going north), and you also cannot move **from 31x13 to 31x14** (going south). Movement is blocked in **both directions** across that edge.
- Entry/exit from the other sides (west, east, south) is still allowed depending on surrounding tiles.

When pathing, treat these as walkable tiles with edge-based collision barriers, not as full walls.
        `);
    }

    if (haveBoulders) {
        out.push(`
<boulder_information>
## Boulder (Rock) Puzzle Mechanics

### Critical Boulder Rules
- **Boulders can only be pushed—never pulled**—so plan your movements carefully
- **Avoid unwinnable positions:** If a boulder gets too close to a wall or corner, it may become stuck, making the puzzle impossible to complete
- **Reset when stuck:** Exit and re-enter the area to reset boulder positions
- **Think ahead:** Always observe your surroundings before pushing to avoid getting stuck

### Boulder Puzzle Objectives
These puzzles typically require:
- Pushing a boulder onto a specific tile to activate a switch
- Opening doors or triggering events
- Moving boulders to create passages
- **Strategic positioning:** If you need to push a boulder right but the left side is blocked, you won't be able to access the correct position to push it again

${!isPathFinding ? `
### Normal Behavior Expectations
- **Collision warnings are normal** when pushing boulders because your player position doesn't change
- **Check boulder position** to confirm if it moved successfully
- **STRENGTH activation** remains active until you change maps
` : ""}

### Boulder Example Walkthrough

In this grid, the avatar starts at **(12,14)** shown as **🧍▶** (facing right).
The boulder is at **(13,14)** shown as **🪨**, and the target switch is at **(17,13)** shown as **🔘**.
Coordinates use *(X,Y)* format where **X increases →** and **Y increases ↓**.

| **Y \ X** | 11 | 12      | 13     | 14 | 15 | 16 | 17 | 18 | 19 |
| --------- | -- | ------- | ------ | -- | -- | -- | -- | -- | -- |
| **10**    | ⛔ | ⛔ | ⛔ | ⛔  | ⛔  | ⛔  | ⛔  | ⛔  | ⛔  |
| **11**    | ⛔ | ⛔ | ⛔ | ⛔  | 🟫 | 🟫 | 🟫 | ⛔  | ⛔  |
| **12**    | ⛔ | ⛔ | ⛔ | 🟫 | 🟫 | 🟫 | 🟫 | ⛔  | ⛔  |
| **13**    | ⛔  | ⛔ | ⛔ | 🟫 | ⛔  | 🟫 | 🔘 | ⛔  | ⛔  |
| **14**    | ⛔  | 🧍▶ | 🪨 | 🟫 | 🟫 | 🟫 | ⛔  | ⛔  | ⛔  |
| **15**    | ⛔  | 🟫 | 🟫 | 🟫 | 🟫 | 🟫 | ⛔  | ⛔  | ⛔  |

### Step-by-Step Solution

### Movement Sequence

1. **Press "right"** while at **(12 × 14)**
   * Boulder is pushed to **(14 × 14)**.
   * Avatar stays at **(12 × 14)**.

2. **Press "right"** again while at **(12 × 14)**
   * Avatar moves to **(13 × 14)**.

3. **Press "right"** while at **(13 × 14)**
   * Avatar moves to **(14 × 14)**.

4. **Press "right"** again while at **(14 × 14)**
   * Boulder pushed to **(16 × 14)**.
   * Avatar stays at **(14 × 14)**.

5. **Press "right"** again while at **(14 × 14)** → avatar to **(15 × 14)**.
6. **Press "down"** → avatar to **(15 × 15)**.
7. **Press "right"** → avatar to **(16 × 15)**.
8. **Press "up"** while at **(16 × 15)**
   * Boulder pushed to **(16 × 13)**.
   * Avatar stays at **(16 × 15)**.

9. **Press "up"** again → avatar to **(16 × 14)**.
10. **Press "up"** while at **(16 × 14)**
    * Boulder pushed to **(16 × 12)**.
    * Avatar stays at **(16 × 
11. **Press "left"** → avatar to **(15 × 14)**.
12. **Press "left"** → avatar to **(14 × 14)**.
13. **Press "up"** → avatar to **(14 × 13)**.
14. **Press "up"** → avatar to **(14 × 12)**.
15. **Press "right"** → avatar to **(15 × 12)**.
16. **Press "right"** while at **(15 × 12)**
    * Boulder pushed to **(17 × 12)**.
    * Avatar stays at **(15 × 12)**.

17. **Press "up"** → avatar to **(15 × 11)**.
18. **Press "right"** → avatar to **(16 × 11)**.
19. **Press "right"** → avatar to **(17 × 11)**.
20. **Press "down"** while at **(17 × 11)**

    * Boulder pushed onto **(17 × 13)** **🔘** — **puzzle solved!**
    * Avatar remains at **(17 × 11)**.

**Final positions:** Avatar at **(17 × 11)**, Boulder at **(17 × 13)** on the switch.

*Summary:* Seven pushes — **right, right, right, up, up, right, down** — with extra walking moves in between to reach the necessary pushing tiles.
    
    `);
        if (!isPathFinding) {
            out.push(`
## Important Guidelines for Boulder Puzzles

### 🚨 CRITICAL RULE: ALWAYS USE \`path_to_location\` TOOL when you struggle to do it manually

### Tool Usage Requirements:
- **Primary method:** Always rely on the \`path_to_location\` tool for all boulder puzzles when you struggle to do it manually
- **Exception:** If interrupted by battle/dialog during tool execution, manually finish the remaining key sequence provided by the tool
- **Prerequisites:** Enable STRENGTH before invoking the tool and position yourself within 3 tiles of the boulder
- **Visibility requirement:** Do not use \`path_to_location\` if the boulder is not in your visible_area—approach the boulder first, then use the tool

### Clear Communication Protocol:
State your intention clearly in the 'explanation' field when using the tool. Always describe the situation and the result you want to achieve:

**Single Boulder Examples:**
> *"Push the boulder from (x,y) to (x,y) to activate the switch."*

**Multiple Boulder Examples:**
> *"Push the boulders at (x,y), (x,y) and (x,y) to open the passage and move to (x,y)"*
> *"Move all the boulders blocking the way to create a passage and move to (x,y)"*

- **Important:** Always include the boulder and hole/switch positions in the explanation field, the target must be the hole/switch also.

**Key Principles:**
- The \`path_to_location\` tool can handle every puzzle or situation
- DO NOT attempt to solve puzzles manually—USE THE TOOL
- For multiple boulders blocking your path, use the tool to move them all at once
- Provide the final target position (where you want to stand after the puzzle is solved)
- Use the explanation field to describe both the situation and desired outcome

**Tool Parameters:** Always provide both boulder and switch positions explicitly to the tool.

### Boulder Mechanics Understanding:
- **Movable boulders:** Only \`🪨\` can be pushed with STRENGTH
- **Immovable boulders:** Decorative boulders \`⛔\` cannot be moved
- **Blocking consequences:** Boulders become permanently blocked if pushed incorrectly
- **Movement restrictions:** Boulders cannot pass through stairs, ladders, or doors
- **Collision behavior:** Ignore collision warnings during pushing—they are normal since your character doesn't move during the push action. Confirm success by checking the boulder's position change

### Reset Strategy When Stuck:
- **When to reset:** If you find a boulder blocked, immediately reset the area
- **How to reset:** Exit and re-enter via exits, stairs, ladders, carpets, or doors
- **Reset reliability:** Resetting is fundamental—there are no "bad default positions" in the game
- **After reset:** Re-attempt the puzzle to ensure correct positioning


**IMPORTANT:** 
- You must approach the boulder before using the \`path_to_location\` tool. Position yourself within 1 tile distance from the boulder you want to push before invoking the tool.
- ALWAYS use markers on the holes you have already filled with a boulder (After you have pushed the boulder into the hole), this is important to remember which holes you have already filled without being lost.
                `);
        }

        if (isPathFinding) {
            out.push(`
                

### Basic Boulder Movement
You may need to solve puzzles by pushing boulders to specific locations. To push a boulder:
- **STRENGTH must be active** (remains active for the entire map until you change areas)
- **Stand on an adjacent tile** and press the direction key toward the boulder (bump into it)
- **The boulder moves one tile** in that direction while your character stays in place
**Pathfinding Tips:**
- If the user asks you to move a boulder but STRENGTH is not active, return an empty path list and notify the player that they must activate STRENGTH first.
- Always use the Python tool to solve boulder puzzles. Reference the example above to understand the correct approach.
- If the boulder can't be moved to the target switch/hole/position, try to compute a path with other boulders present on the map, and if you find a solution, use this solution instead and explain it to the user. Sometimes the user will target the wrong boulder or the wrong destination hole/switch.
- If there is no solution to the boulder puzzle (the boulder is blocked by a wall or another boulder), this means the player blocked the boulder(s) before asking you to solve it. Notify the player that they must reset the map by exiting and returning to the room; this will reset the boulder(s) position and you will be able to solve the puzzle.
- Always be sure to understand the example above to build your pathfinding algorithm; this is important to push the boulder to the correct position and understand the logic.
- Sometimes a boulder must be pushed to free a path even if this boulder is not the one the user asked you to push. Some mazes require moving multiple boulders to free a path or to be able to push the real boulder to the target. Always think about that when there are multiple boulders around the player/target.
- Sometimes the user will target the wrong boulder or the wrong destination hole/switch. If there is no solution to what the user asked you to do, check the other combinations of boulders and holes/switches to see if there is a solution and return your finding in your explanation.
            `);
        }

        out.push(`
</boulder_information>
        `);
    }



    out.push(`
# Exploration & NPC Navigation Reminder

**Priority: Unexplored Areas (❓ tiles)** - Always prioritize exploring ❓ tiles on your minimap immediately when spotted. Use 'path_to_location' to navigate to the nearest unexplored area. Never wander in known areas when unexplored regions exist. Map exploration is mandatory - areas remain hidden until actively explored.

**Dynamic NPC Positioning** - NPCs move throughout the map and may block pathways. Wait for them to relocate if they obstruct your route. When searching for specific NPCs, note that they won't appear on your minimap if they moved while outside your visible range. This requires re-exploring previously known areas to update minimap data and locate moved NPCs.


`);

    if (haveIceTiles) {
        out.push(`
### Ice Mechanics (Thin/Cracked Ice)

This map contains **Thin Ice (🧊)** and **Cracked Ice (🧊⚡)** tiles.

**Mechanics:**
- **Thin Ice (🧊)**: Walkable ice that becomes cracked after stepping on it
- **Cracked Ice (🧊⚡)**: Previously walked ice that will break if stepped on again
- Breaking through ice may drop you to a lower floor or reset puzzle state

**Pathfinding Implications:**
- Track which ice tiles have been stepped on in puzzle contexts
- Avoid pathing through the same ice tile twice
- Some ice puzzles may require specific movement sequences to avoid breaking through
- For simple traversal, thin ice is passable like normal ground

**Note**: 
- This is a crack-and-break mechanic (not continuous sliding).
- You can use the \`path_to_location\` tool to solve the ice puzzle and pass through the Arrow Floor Down tiles. Simply target the Ice tile immediately after the Arrow Floor Down tile, and the tool will find a path to solve the puzzle and convert the Arrow Floor Down tile to free ground.
- You must use the \`path_to_location\` tool for each group of 2 "Arrow Floor Down" tiles. Do not attempt to solve 2 puzzles at once! First use the tool to go one tile after the first group of Arrow Floor Down tiles, and then do it again next turn for the second group of Arrow Floor Down tiles etc ...

        `);
    }

    if (haveSpinners) {
        out.push(`
**Spinner Mechanics:**
Stepping onto a **Directional Spinner**—one of the arrow tiles like **🌀←, 🌀↑, 🌀→, 🌀↓**—starts an *automatic spin* in that arrow's direction.

* **Hands-off travel:** Once the spin begins, the avatar slides one tile per game tick in the shown direction. No further keystrokes are required.
* **Dynamic redirection:** If the moving avatar lands on another Directional Spinner, its facing is instantly replaced by the new arrow, and the spin continues in that fresh direction.
* **Where the ride ends:** The chain stops only when the next target tile is

  * a **Stop Spinner** **🌀⏹️** → you step onto it and halt, or
  * an **impassable tile** (wall, void, etc.) → you stop on the last walkable tile *before* that obstacle.

* **Input pause:** While spinning, newly-pressed keys are queued but not executed.
* When the avatar stops on a 🌀⏹️ (or the last walkable tile before an obstacle), the queue resumes and the stored keys play out in order.
* **Stop Spinner properties:** A **🌀⏹️** acts like ordinary floor when walked onto, but it is the *sole* tile that can end a spin chain.

**Key Point:** During a spin you never need (or can) press direction keys—the spinners do all the moving.

**Example:** Step onto **🌀↓** from any adjacent cell → the avatar immediately travels downward with a single key press → if another Directional Spinner is reached mid-spin, your facing changes and the chain continues → the process repeats until you land on **🌀⏹️** (or stop just before an obstacle) → input control returns at that final position.

**Chain Reaction:** Spinners can be laid out so a single step triggers a sequence like DS → DS → DS → SS, with each spinner turning you until an SS or obstacle finally ends the motion.

**path_to_location tool:** The \`path_to_location\` tool handle the spinners too, you can use it.


<spinner_example>
In the grid below the avatar is at **(8 × 11)**, shown as **🧍▶** (facing right). Coordinates are written *(X,Y)* where **X increases →** and **Y increases ↓**.
In this example the target is **(5 × 9)**

| Y \\ X | 4    | 5 | 6 | 7 | 8   |
| ----- | ---- | - | - | - | --- |
| 9     | 🌀⏹️ | ⬜ | ⬜ | ⬜ | 🌀← |
| 10    | ⛔    | ⛔ | ⛔ | ⛔ | ⬜   |
| 11    | ⬜    | ⬜ | ⬜ | ⛔ | 🧍▶ |
| 12    | ⬜    | ⬜ | ⬜ | ⛔ | 🌀↑ |

### Movement Sequence

1. **Press "down"** while at **(8 × 11)**

   * Avatar moves to **(8 × 12)**, landing on **🌀↑**.
   * The spinner forces an upward spin; input is locked.
   * The avatar travels up to **(8 × 9)**, reaching **🌀←**.
   * That spinner turns the avatar left; the spin continues to **(4 × 9)**, a **🌀⏹️** stop spinner.
   * Upon entering **(4 × 9)** the spin ends and input is unlocked.

2. The entire path—**(8 × 11) → (8 × 12) → (8 × 9) → (4 × 9)**—occurs automatically from one **"down"** key press.

3. **Press "right"** next, and the avatar simply walks from **(4 × 9)** to **(5 × 9)**.

*Summary:* From **(8 × 11)** a key sequence of **"down", then "right"** produces the automatic spin to **(4 × 9)** followed by a manual step to **(5 × 9)**—no *"up"* or *"left"* keys required thanks to the spinners.

IMPORTANT: All the movements between the spinners are automatic, you don't need to press any keys, the spinners do the movement for you based on the rules above.
</spinner_example>

`);
    }

    out.push(`\n</navigation_notes>\n`);
    out.push(`
<reminder>
* Be mindful of **collision tiles** when planning a route. Check the legend to see which tiles have collisions (NPCs, walls, etc.).
* **Menu navigation:** you can’t predict every outcome. Go slowly—send only a few \`key_press\` inputs at a time. There’s no limit on directional inputs, but avoid batching many \`"a"\` or \`"a_until_end_of_dialog"\` presses in one turn; this can cause serious mistakes (like throwing items).
* Don’t add a marker to an NPC until **after** you’ve spoken to them and received a new screenshot confirming the interaction. Avoid combining movement, dialogue, and marker placement in the same turn. Only perform bulk actions when you’re 100% confident.
* If a battle or dialogue **interrupts** \`path_to_location\`, do **not** call it again. Use \`key_press\` to send \`<remaining_commands>\` and finish the original path. This prevents wasting time on a full recalculation.
* **Item management:** always carry healing items and buy more when needed. Don’t hoard money—you can lose half on fainting. Spending on useful items is smarter. When you are in a city, take your time to stop by the shop to refill your items, do not rush without checking your inventory first! You must have potions and status healing items in your inventory at all times.
**Learn with mistakes:** Always use your memory with the \`memory\` tool to remember what went wrong and how to fix it to avoid the same mistake in the future. Every mistake should be analyzed and used to improve your future actions, the \`memory\` tool is the best way to do this! Use the prefix "tips_" to save the tip in your memory.
Notes:
- Always send as many keys as possible to move faster in the overworld per step, avoid to move only one or two tiles at a time. You can plan your route and send all the keys at once.




</reminder>
`);

    return out.join("\n");
}

/**
 * Searches for the player tile ID in the game area to determine orientation
 * @param {Array} gameAreaGrid Game area grid
 * @param {number} localRow Player row in the grid
 * @param {number} localCol Player column in the grid
 * @returns {number|null} Player tile ID or null if not found
 */
function findPlayerInGameArea(gameAreaGrid, localRow, localCol) {
    // Added safety checks for gameAreaGrid structure
    if (!Array.isArray(gameAreaGrid) || gameAreaGrid.length === 0 || !Array.isArray(gameAreaGrid[0])) {
        console.warn("findPlayerInGameArea called with invalid grid");
        return null;
    }
    const H = gameAreaGrid.length;
    const W = gameAreaGrid[0].length;


    if (localRow >= 0 && localRow < H &&
        localCol >= 0 && localCol < W &&
        gameAreaGrid[localRow][localCol] >= 100 &&
        gameAreaGrid[localRow][localCol] <= 103) {
        return gameAreaGrid[localRow][localCol];
    }

    // Search for the player elsewhere in the grid (case where the player is not centered)
    // This might happen if gameAreaGrid is smaller or player is near edge
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (gameAreaGrid[y][x] >= 100 && gameAreaGrid[y][x] <= 103) {
                console.warn(`Player found at non-standard location (${x},${y}) in gameAreaGrid.`);
                return gameAreaGrid[y][x];
            }
        }
    }
    console.warn("Player tile (100-103) not found in gameAreaGrid.");
    return null; // Return null if player tile not found
}

/**
 * Formats MARKDOWN_TILES object into a readable legend string
 * @returns {string} Formatted legend string
 */
function formatTilesLegend() {
    const entries = [];

    // Sort the keys numerically for better readability
    const sortedKeys = Object.keys(MARKDOWN_TILES).sort((a, b) => {
        const numA = isNaN(a) ? parseInt(a) || 999 : parseInt(a);
        const numB = isNaN(b) ? parseInt(b) || 999 : parseInt(b);
        return numA - numB;
    });

    for (const key of sortedKeys) {
        const [emoji, description] = MARKDOWN_TILES[key];
        entries.push(`${key}: ${emoji} ${description}`);
    }

    return entries.join('\n');
}


module.exports = { mdRow, mdSep, gameAreaToMarkdown, minimapToMarkdown, findPlayerInGameArea, formatTilesLegend };
