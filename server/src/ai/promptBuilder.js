const fs = require("fs").promises;
const path = require("path");

const { state } = require("../state/stateManager");
const { config } = require("../config");
const { gameAreaToMarkdown, minimapToMarkdown } = require("../formatters/markdownFormatter");

function escapeXml(text) {
  if (text == null) return "";
  return String(text);
    // .replace(/&/g, "&amp;")
    // .replace(/</g, "&lt;")
    // .replace(/>/g, "&gt;")
    // .replace(/"/g, "&quot;")
    // .replace(/'/g, "&apos;");
}

function formatMemoryStructured(memoryObj) {
  const entries = memoryObj && typeof memoryObj === "object" ? Object.entries(memoryObj) : [];
  if (entries.length === 0) return "<memory />\n";

  const lines = ["<memory>"];
  for (const [k, v] of entries) {
    lines.push(`  <item key="${escapeXml(k)}">${escapeXml(v)}</item>`);
  }
  lines.push("</memory>");
  return lines.join("\n") + "\n";
}

function formatRecentMarkers(markers, lastVisitedMaps, isInDialog) {
  if (!markers || typeof markers !== "object" || Object.keys(markers).length === 0) {
    return "<markers>No markers set</markers>\n";
  }

  if (isInDialog) {
    return "<markers>Markers are not visible in dialogue</markers>\n";
  }

  const visited = Array.isArray(lastVisitedMaps) ? lastVisitedMaps : [];
  const lastVisitedMapIds = new Set(visited.map((entry) => String(entry?.map_id ?? "")));
  const mapIdToName = new Map(
    visited
      .filter((e) => e && typeof e === "object" && e.map_id != null)
      .map((e) => [String(e.map_id), String(e.map_name || `Unknown Map (${e.map_id})`)])
  );

  const mapMarkerStrings = [];
  for (const [mapId, mapMarkers] of Object.entries(markers)) {
    if (!lastVisitedMapIds.has(String(mapId))) continue;
    if (!mapMarkers || typeof mapMarkers !== "object" || Object.keys(mapMarkers).length === 0) continue;

    const mapName =
      mapIdToName.get(String(mapId)) ||
      mapMarkers[Object.keys(mapMarkers)[0]]?.map_name ||
      `Unknown Map (${mapId})`;

    const sortedCoords = Object.keys(mapMarkers).sort((a, b) => {
      const [ax, ay] = a.split("_").map(Number);
      const [bx, by] = b.split("_").map(Number);
      if (ay !== by) return ay - by;
      return ax - bx;
    });

    const individualMarkerStrings = [];
    for (const coords of sortedCoords) {
      const marker = mapMarkers[coords];
      if (!marker || typeof marker !== "object") continue;
      const [x, y] = coords.split("_");
      individualMarkerStrings.push(`(${x}, ${y})=${marker.emoji} ${marker.label}`);
    }

    if (individualMarkerStrings.length === 0) continue;

    mapMarkerStrings.push(`  <map_markers map_id="${escapeXml(mapId)}" map_name="${escapeXml(mapName)}">
  ${individualMarkerStrings.map((s) => escapeXml(s)).join("\n    ")}
</map_markers>`);
  }

  if (mapMarkerStrings.length === 0) {
    return "<markers>No markers set in recently visited maps</markers>\n";
  }

  return `           
<markers>
Your current markers from recently visited maps:
${mapMarkerStrings.join("\n")}
Notes:
- The markers may be inaccurate since you defined them yourself.
- Fix or delete markers as soon as you notice they are inaccurate.
- Remember marker ownership: All markers are set by you—they are not extracted from RAM.
</markers>
\n`;
}

function formatObjectives(objectives, currentMapId, currentMapName) {
  if (!objectives || typeof objectives !== "object") return "<objectives />\n";

  const safe = (o) => (o && typeof o === "object" ? o : { short_description: "", description: "" });
  const primary = safe(objectives.primary);
  const secondary = safe(objectives.secondary);
  const third = safe(objectives.third);
  const others = Array.isArray(objectives.others) ? objectives.others : [];

  //  DAEMONS: an empty objectives block has to ASK, not just be empty.
  //
  //  A --fresh run wipes objectives.json, and what the model then reads is
  //  <primary short=""></primary> -- silent empty tags. Across a whole run it
  //  called update_objectives exactly zero times and wandered a bedroom with
  //  no stated goal at all. Nothing in 14,810 tokens of instruction ever says
  //  "these are blank and setting them is your job", and blank reads as
  //  "nothing here", the same way the unnamed staircase did.
  const nothingSet = !(primary.short_description || secondary.short_description
                       || third.short_description || others.length);

  const lines = ["<objectives>"];
  //  Written elsewhere? Say so. Coordinates in an objective mean nothing on a
  //  different map, and a confidently wrong destination is worse than none.
  //  No stamp at all means the objective predates the stamping, so we cannot
  //  tell which map it was written for -- and "cannot tell" has to be said,
  //  not skipped. This is the case that actually bit: a primary carried down
  //  the stairs still reading "stairs at (9, 2)", an upstairs coordinate,
  //  while the exits line named a door at (4, 9). Two instructions, no way to
  //  know the older one was stale. It self-heals: the next update_objectives
  //  stamps the map and this note stops.
  if (!nothingSet && !objectives.map_id && currentMapId) {
    lines.push(
      "  <!-- NOTE: these objectives carry no map stamp, so they may have been"
      + " written on a different map. Any coordinates below could refer to"
      + " somewhere else. Trust the exits listed above the grid instead, and"
      + " call update_objectives to restate the goal for this map. -->"
    );
  }
  if (!nothingSet && objectives.map_id && currentMapId && objectives.map_id !== currentMapId) {
    lines.push(
      `  <!-- NOTE: these objectives were written on map ${objectives.map_id}`
      + `${objectives.map_name ? " (" + objectives.map_name + ")" : ""} and you are now on `
      + `${currentMapId}${currentMapName ? " (" + currentMapName + ")" : ""}. Any coordinates below`
      + " refer to the OTHER map. Re-read the exits listed above and call update_objectives"
      + " before acting on them. -->"
    );
  }
  if (nothingSet) {
    lines.push(
      "  <!-- EMPTY. You have no objectives yet. Call update_objectives NOW,"
      + " before moving, and set a primary objective you can actually act on"
      + " this turn -- e.g. leaving this map by one of the exits listed above. -->"
    );
  }
  lines.push(
    `  <primary short="${escapeXml(primary.short_description || "")}">${escapeXml(primary.description || "")}</primary>`
  );
  lines.push(
    `  <secondary short="${escapeXml(secondary.short_description || "")}">${escapeXml(
      secondary.description || ""
    )}</secondary>`
  );
  lines.push(
    `  <third short="${escapeXml(third.short_description || "")}">${escapeXml(third.description || "")}</third>`
  );
  if (others.length > 0) {
    lines.push("  <others>");
    for (const o of others) {
      const oo = safe(o);
      lines.push(
        `    <objective short="${escapeXml(oo.short_description || "")}">${escapeXml(
          oo.description || ""
        )}</objective>`
      );
    }
    lines.push("  </others>");
  }
  lines.push("</objectives>");
  return lines.join("\n") + "\n";
}

function formatInventory(inventory) {
  if (!inventory || typeof inventory !== "object") return "<inventory />\n";

  const pocketOrder = ["item_pocket", "key_item_pocket", "ball_pocket", "tm_case", "berries_pocket"];
  const pocketLabels = {
    item_pocket: "Items",
    key_item_pocket: "Key Items",
    ball_pocket: "Balls",
    tm_case: "TM Case",
    berries_pocket: "Berries",
  };

  const lines = ["<inventory>"];
  let globalIdx = 0;

  for (const pocketName of pocketOrder) {
    const pocket = inventory[pocketName];
    if (!Array.isArray(pocket) || pocket.length === 0) continue;
    lines.push(`  <pocket name="${escapeXml(pocketLabels[pocketName] || pocketName)}">`);
    pocket.forEach(([itemName, qty], pocketIdx) => {
      lines.push(
        `    <item index_id="${globalIdx}" name="${escapeXml(itemName)}" quantity="${Number(qty) || 0}" pocket_index="${pocketIdx}" />`
      );
      globalIdx += 1;
    });
    lines.push("  </pocket>");
  }

  lines.push("</inventory>");
  return lines.join("\n") + "\n";
}

function formatPcItems(pcItems) {
  const items = Array.isArray(pcItems) ? pcItems : [];
  const lines = [`<pc_items slot_count="${items.length}/50">`];
  if (items.length === 0) {
    lines.push("  <info>PC is empty</info>");
    lines.push("</pc_items>");
    return lines.join("\n") + "\n";
  }

  items.forEach((item, idx) => {
    lines.push(
      `  <item index_id="${idx}" name="${escapeXml(item?.name || "")}" quantity="${Number(item?.quantity) || 0}" />`
    );
  });
  lines.push("</pc_items>");
  return lines.join("\n") + "\n";
}

function formatPcPokemon(pcData) {
  const currentBox = Number(pcData?.current_box) || 1;
  const mons = Array.isArray(pcData?.pokemons) ? pcData.pokemons : [];
  const lines = [`<cold_storage current_box="${currentBox}" slot_count="${mons.length}/30">`];

  if (mons.length === 0) {
    lines.push("  <info>COLD STORAGE is empty</info>");
    lines.push("</cold_storage>");
    return lines.join("\n") + "\n";
  }

  for (const pokemon of mons) {
    if (!pokemon) continue;
    const nickname = pokemon.nickname || pokemon.species_name || "";
    const moves = Array.isArray(pokemon.moves) ? pokemon.moves : [];
    const moveList = moves.map((m) => `${m.name} (${Number(m.pp) || 0} PP)`).join(", ");
    const types = Array.isArray(pokemon.types) ? pokemon.types.join(", ") : "";

    lines.push(
      `  <daemon slot_id="${Number(pokemon.slot_id) || 0}" species="${escapeXml(
        pokemon.species_name || ""
      )}" nickname="${escapeXml(nickname)}" level="${Number(pokemon.level) || 0}">`
    );
    lines.push(`    <hp current="${Number(pokemon.current_hp) || 0}" max="${Number(pokemon.max_hp) || 0}" />`);
    lines.push(`    <moves>${escapeXml(moveList)}</moves>`);
    lines.push(`    <types>${escapeXml(types)}</types>`);
    lines.push(`    <status>${escapeXml(pokemon.status || "OK")}</status>`);
    lines.push(`    <pokedex_id>${Number(pokemon.pokedex_id) || 0}</pokedex_id>`);
    lines.push("  </daemon>");
  }

  lines.push("</cold_storage>");
  return lines.join("\n") + "\n";
}

function formatPokemonTeam(team) {
  const mons = Array.isArray(team) ? team : [];
  const lines = ["<daemon_team>"];

  if (mons.length === 0) {
    lines.push("  <info>No Pokémon in party</info>");
    lines.push("</daemon_team>");
    return lines.join("\n") + "\n";
  }

  for (const pokemon of mons) {
    const nickname = pokemon.nickname || pokemon.species_name;
    const status = pokemon.status || "OK";
    const moves = Array.isArray(pokemon.moves) ? pokemon.moves : [];
    const ability = pokemon.ability || "UNKNOWN";
    const heldItemId = Number(pokemon.held_item_id) || 0;
    const heldItemNameRaw = typeof pokemon.held_item_name === "string" ? pokemon.held_item_name : "";
    const heldItemName = heldItemNameRaw || (heldItemId ? "UNKNOWN" : "NONE");
    lines.push(
      `  <daemon species="${escapeXml(pokemon.species_name)}" nickname="${escapeXml(
        nickname
      )}" level="${Number(pokemon.level) || 0}">`
    );
    lines.push(`    <hp current="${Number(pokemon.current_hp) || 0}" max="${Number(pokemon.max_hp) || 0}" />`);
    lines.push(`    <held_item id="${heldItemId}" name="${escapeXml(heldItemName)}" />`);
    lines.push("    <moves>");
    for (const m of moves) {
      lines.push(`      <move name="${escapeXml(m.name)}" pp="${Number(m.pp) || 0}" />`);
    }
    lines.push("    </moves>");
    lines.push(`    <types>${escapeXml((pokemon.types || []).join(", "))}</types>`);
    lines.push(`    <ability>${escapeXml(ability)}</ability>`);
    lines.push(`    <status>${escapeXml(status)}</status>`);
    lines.push(`    <is_shiny>${pokemon.is_shiny ? "true" : "false"}</is_shiny>`);
    lines.push("  </daemon>");
  }

  lines.push("</daemon_team>");
  return lines.join("\n") + "\n";
}

function formatBattleState(battleData) {
  const inBattle = Boolean(battleData?.in_battle);
  if (!inBattle) return `<battle_state active="false" />\n`;

  const playerMons = Array.isArray(battleData?.player_pokemons) ? battleData.player_pokemons : [];
  const enemyMons = Array.isArray(battleData?.enemy_pokemons) ? battleData.enemy_pokemons : [];

  const lines = [`<battle_state active="true">`];

  lines.push(`  <player_side count="${playerMons.length}">`);
  for (const p of playerMons) {
    if (!p) continue;
    const nickname = p.nickname || p.species_name;
    lines.push(
      `    <daemon species="${escapeXml(p.species_name)}" nickname="${escapeXml(
        nickname
      )}" level="${Number(p.level) || 0}" position="${escapeXml(p.position || "")}">`
    );
    lines.push(`      <hp current="${Number(p.current_hp) || 0}" max="${Number(p.max_hp) || 0}" />`);
    lines.push(`      <status>${escapeXml(p.status || "OK")}</status>`);
    lines.push("      <moves>");
    for (const m of p.moves || []) {
      lines.push(`        <move name="${escapeXml(m.name)}" pp="${Number(m.pp) || 0}" />`);
    }
    lines.push("      </moves>");
    lines.push(`      <types>${escapeXml((p.types || []).join(", "))}</types>`);
    lines.push("    </daemon>");
  }
  lines.push("  </player_side>");

  lines.push(`  <enemy_side count="${enemyMons.length}">`);
  for (const e of enemyMons) {
    if (!e) continue;
    const curHp = Number(e.current_hp) || 0;
    const maxHp = Number(e.max_hp) || 0;
    const hpPct =
      maxHp > 0 ? Math.max(0, Math.min(100, Math.round((curHp / maxHp) * 100))) : null;
    lines.push(
      `    <daemon species="${escapeXml(e.species_name)}" level="${Number(e.level) || 0}" position="${escapeXml(
        e.position || ""
      )}">`
    );
    // Do not reveal exact enemy HP numbers; percentage is enough.
    lines.push(`      <hp percentage="${hpPct == null ? "unknown" : `${hpPct}%`}" />`);
    lines.push(`      <status>${escapeXml(e.status || "OK")}</status>`);
    lines.push(`      <types>${escapeXml((e.types || []).join(", "))}</types>`);
    lines.push("    </daemon>");
  }
  lines.push("  </enemy_side>");

  lines.push("</battle_state>");
  return lines.join("\n") + "\n";
}

async function buildUserInputText(gameDataJson) {
  const { counters } = state;
  //  DAEMONS: what has actually changed since the current objective was set.
  //  A score would be a fact about the past; a next action cannot answer it.
  //  "2 new maps, nothing else" can be answered, and when it says NOTHING has
  //  changed that is the strongest signal in the prompt that the current plan
  //  is not working.
  let progressLine = "";
  try {
    const progress = require("../core/progress.js");
    progressLine = progress.delta(state.progressNow, state.progressMark) || "";
  } catch (e) { /* never let a status line break a turn */ }

  const trainer = gameDataJson?.current_trainer_data || null;
  const pos = trainer?.position || { map_name: "Unknown", map_id: "0-0", x: 0, y: 0, elevation: 0 };
  const isInDialog = Boolean(gameDataJson?.is_talking_to_npc);

  const movementMode = gameDataJson?.player_movement_mode || "WALK";
  const strengthEnabled = Boolean(gameDataJson?.strength_enabled);

  const visibilityReduced = Boolean(gameDataJson?.visibility_reduced);

  const visibleGrid = Array.isArray(gameDataJson?.game_area_meta_tiles) ? gameDataJson.game_area_meta_tiles : null;
  const minimap = gameDataJson?.minimap_data || null;
  const visibleAreaOrigin = gameDataJson?.visible_area_data?.origin || { x: pos.x, y: pos.y };
  const visibleW = gameDataJson?.visible_area_data?.width || (visibleGrid && visibleGrid[0] ? visibleGrid[0].length : 0);
  const visibleH = gameDataJson?.visible_area_data?.height || (visibleGrid ? visibleGrid.length : 0);
  // FireRed bridge: the visible grid comes with an origin (top-left world coords),
  // so the player's local position in the grid is (player - origin).
  let localRow = Number(pos.y) - Number(visibleAreaOrigin.y);
  let localCol = Number(pos.x) - Number(visibleAreaOrigin.x);
  if (!Number.isFinite(localRow) || localRow < 0 || localRow >= visibleH) {
    localRow = visibleH ? Math.floor(visibleH / 2) : 0;
  }
  if (!Number.isFinite(localCol) || localCol < 0 || localCol >= visibleW) {
    localCol = visibleW ? Math.floor(visibleW / 2) : 0;
  }

  let gameAreaDisplay = null;
  let minimapDisplay = null;

  if (!isInDialog && visibleGrid && minimap && minimap.grid) {
    // Viewport uses `origin` instead of assuming the player is always at (4,4).
    // Keep markdown format stable and adapt coordinate math in the formatter.
    gameAreaDisplay = gameAreaToMarkdown(
      visibleGrid,
      pos.x,
      pos.y,
      pos.map_id,
      pos.map_name,
      minimap.grid.length,
      minimap.grid[0]?.length || 0,
      visibleAreaOrigin.x,
      visibleAreaOrigin.y,
      minimap.orientation ?? null,
      gameDataJson?.npc_entries_visible ?? null
    );

    // Console log the visible game area
    console.log("Visible game area:", gameAreaDisplay);

    minimapDisplay = minimapToMarkdown(
      minimap,
      pos.x,
      pos.y,
      pos.map_id,
      pos.map_name,
      minimap.orientation ?? null,
      visibleGrid,
      localRow,
      localCol,
      gameDataJson?.npc_entries ?? null,
      false,
      //  Where the map's edges lead. Present in game_data.json on every step
      //  and never once shown to the model until now.
      gameDataJson?.firered_state?.map?.connections
        ?? gameDataJson?.raw_state?.map?.connections
        ?? null
    );
  }


  const trainerName = trainer?.name || "PLAYER";
  const money = trainer?.money ?? 0;
  const badgeCount = trainer?.badge_count ?? 0;
  // DAEMONS: BEFORE A GAME IS RUNNING, THE RAM IS NOT STATE -- IT IS ZEROES.
  // On the title screen no save is loaded, so gSaveBlock1Ptr resolves to
  // nothing, map id 0-0 comes back as BATTLE_COLOSSEUM_2_P, the position reads
  // 0,0 and the dialog flag is garbage. The agent was being told, in
  // structured text it trusts more than the screenshot, that it stood in a
  // battle colosseum inside a dialogue -- and pressing buttons to escape that
  // is a reasonable answer to a false premise. It never pressed START because
  // nothing ever said there was a title screen.
  //
  // Detected rather than assumed: map 0-0 at exactly 0,0 with no player name
  // is not a place anyone can stand.
  const preGame = (pos.map_id === "0-0" || !pos.map_id)
      && Number(pos.x) === 0 && Number(pos.y) === 0
      && (!trainer?.name || trainer.name === "PLAYER");
  if (preGame) {
    return `
<game_state timestamp="${new Date().toISOString()}" current_step="${counters.currentStep}">
<current_situation>
  <not_started>true</not_started>
  <note>The game has NOT started. No save is loaded, so there is no map, no
  position and no party -- any location data is uninitialised memory, not a
  place. Read the SCREENSHOT and nothing else. You are on the title screen, an
  intro sequence, or the opening narration.</note>
  <required_action>Call execute_action NOW with a key_press. Do not reply with
  text. Press "start" on a title screen, or "a" to advance narration or a
  dialogue. If a name is being entered, use the on-screen keyboard and confirm.
  If a choice is offered, read it and pick one.</required_action>
</current_situation>
</game_state>`;
  }

  let userInputText = `
<game_state timestamp="${new Date().toISOString()}" current_step="${counters.currentStep}">
<current_situation>
  <player_location map="${escapeXml(pos.map_name)}" map_id="${escapeXml(pos.map_id)}" x="${pos.x}" y="${pos.y}" elevation="${Number(pos.elevation) || 0}" />
  <dialog_status active="${isInDialog}">${isInDialog ? "In dialogue/menu" : "Free movement"}</dialog_status>
  ${isInDialog ? `<dialog_text>${escapeXml(gameDataJson?.open_dialog_text || "")}</dialog_text>` : ""}
  <movement_mode>${escapeXml(movementMode)}</movement_mode>
  <strength_status>${strengthEnabled ? "true" : "false"}</strength_status>
  <flash_needed>${gameDataJson?.flash_needed ? "true" : "false"}</flash_needed>
  <flash_active>${gameDataJson?.flash_active ? "true" : "false"}</flash_active>
  <visibility reduced="${visibilityReduced ? "true" : "false"}" window="${visibleH}x${visibleW}">
    ${visibilityReduced ? "Visibility is reduced due to darkness." : ""}
  </visibility>
</current_situation>

<player_stats>
  <trainer name="${escapeXml(trainerName)}" money="${money}" badges="${badgeCount}/8" />
  ${formatPokemonTeam(gameDataJson?.current_pokemon_data)}
  ${formatInventory(gameDataJson?.inventory_data)}
  ${formatPcItems(gameDataJson?.pc_items)}
  ${formatPcPokemon(gameDataJson?.pc_data)}
</player_stats>

${formatBattleState(gameDataJson?.battle_data)}

<objectives_section>
${formatObjectives(state.objectives, gameDataJson?.current_trainer_data?.position?.map_id, gameDataJson?.current_trainer_data?.position?.map_name)}
${progressLine ? "<progress>\n" + progressLine + "\n</progress>\n" : ""}
</objectives_section>

${formatMemoryStructured(state.memory)}

${formatRecentMarkers(state.markers, state.lastVisitedMaps, isInDialog)}

<visible_area>
${isInDialog ? "Not visible in dialogue" : gameAreaDisplay || "No visible area data"}
</visible_area>

<explored_map>
${isInDialog ? "Not visible in dialogue" : minimapDisplay || "No minimap data"}
</explored_map>

</game_state>
  `.trim();

  if (state.selfCritiqueReminderPending) {
    userInputText += `
<self_criticism_reminder>
Before taking the next action, update the <memory> / <objectives> / <markers> sections exactly as indicated by your latest self-criticism using the memory / objectives / markers management tools.
Read your self-criticism carefully and update the sections accordingly as mentioned in the self-criticism.
You can safely update them all at once.
</self_criticism_reminder>`;
    state.selfCritiqueReminderAcknowledged = true;
  }

  // Save the userInputText into a debug file
  fs.writeFile(config.paths.lastUserInputTextSaveFile, userInputText, "utf8");

  return userInputText;
}

//  DAEMONS: do not advertise tools the schema does not carry.
//
//  The lean schema has five tools and no add_marker. The prompt describes
//  add_marker four times anyway, including a "VERY IMPORTANT: MARKER PLACEMENT
//  RULE" in the map legend, so the model dutifully tried:
//
//    add_marker @ (undefined, undefined) map ?
//    Error: Invalid marker coordinates.
//
//  That is the harness telling the model to do something, the model obeying,
//  and the harness rejecting it. Switching to --full-schema would fix the
//  contradiction by adding three more tools plus a rule that pulls a small
//  model toward annotating maps instead of leaving the room -- the wrong
//  direction. Removing the advertisement is cheaper and truer.
function stripMarkerGuidance(text) {
    return text
        //  the tool's own bullet, up to the next top-level bullet
        .replace(/\* \*\*`add_marker`[\s\S]*?(?=\n\* \*\*`)/g, "")
        //  the emphatic placement rule
        .replace(/^.*MARKER PLACEMENT RULE.*$/gm, "")
        //  and any lingering mention in a tool list
        .replace(/, `add_marker`/g, "")
        .replace(/`add_marker` \/ `delete_marker`/g, "")
        .replace(/\n{3,}/g, "\n\n");
}

async function buildDeveloperPrompt() {
  let gamePrompt = await fs.readFile(path.join(config.promptsDir, "game.txt"), "utf8");
  //  Only the full schema carries add_marker. Keyed off the same env var
  //  defineTools() reads, so the prompt and the tool list cannot disagree.
  if ((process.env.DAEMONS_SCHEMA || "full") !== "full") {
    gamePrompt = stripMarkerGuidance(gamePrompt);
  }
  return {
    role: "developer",
    content: [{ type: "input_text", text: gamePrompt }],
  };
}

module.exports = { buildUserInputText, formatMemoryStructured, buildDeveloperPrompt };
