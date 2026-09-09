const { config } = require("../config");

function cleanTextSections(text, sectionsToRemove) {
  let cleanedText = text;
  if (sectionsToRemove.minimap) {
    cleanedText = cleanedText.replace(/<explored_map>[\s\S]*?<\/explored_map>\s*/g, "");
  }
  if (sectionsToRemove.view_map) {
    cleanedText = cleanedText.replace(/<visible_area>[\s\S]*?<\/visible_area>\s*/g, "");
  }
  if (sectionsToRemove.memory) {
    cleanedText = cleanedText.replace(/<memory>[\s\S]*?<\/memory>\s*/g, "");
    cleanedText = cleanedText.replace(/<markers>[\s\S]*?<\/markers>\s*/g, "");
    cleanedText = cleanedText.replace(/<action_context[\s\S]*?<\/action_context>\s*/g, "");
    cleanedText = cleanedText.replace(/<menu_tips>[\s\S]*?<\/menu_tips>\s*/g, "");
    cleanedText = cleanedText.replace(/<ui_state>[\s\S]*?<\/ui_state>\s*/g, "");
  }
  if (sectionsToRemove.player_data) {
    cleanedText = cleanedText.replace(/<player_stats>[\s\S]*?<\/player_stats>\s*/g, "");
    cleanedText = cleanedText.replace(/<battle_state>[\s\S]*?<\/battle_state>\s*/g, "");
    cleanedText = cleanedText.replace(/<objectives>[\s\S]*?<\/objectives>\s*/g, "");
    cleanedText = cleanedText.replace(/<pc_tips>[\s\S]*?<\/pc_tips>\s*/g, "");
    cleanedText = cleanedText.replace(/<battle_state[\s\S]*?<\/battle_state>\s*/g, "");
  }
  if (sectionsToRemove.pokedex_data) {
    cleanedText = cleanedText.replace(/<pokedex_data>[\s\S]*?<\/pokedex_data>\s*/g, "");
  }
  return cleanedText;
}

//  DAEMONS: drop the model's own thinking out of its own context.
//
//  Measured on a real 486-item conversation totalling 882,686 chars:
//
//    105 x reasoning            248,324  28.1%
//     58 x message              235,364  26.7%
//    126 x user                 235,755  26.7%
//     98 x function_call_output  67,160   7.6%
//      1 x developer             59,216   6.7%
//     98 x function_call         36,867   4.2%
//
//  The model's own output is 54.8% of what it is asked to read. keepLastN*
//  trims tool results and user messages and never touched either category, so
//  the prompt reached 82,524 tokens -- about 41 seconds of prefill before the
//  model thinks at all, and still climbing.
//
//  Reasoning blocks are the clearest waste: they are the thinking that
//  produced an action, and once the action is taken and its result recorded,
//  they inform nothing. They are also exactly the material the model echoes
//  back at itself. Hosted reasoning models drop them from context by
//  convention; here they were all kept.
//
//  Older ones are dropped entirely. The most recent few stay, so the immediate
//  train of thought survives into the next turn.
function dropOldReasoning(history) {
  const keep = config.history.keepLastNReasoningItems;
  if (!Number.isFinite(keep) || keep < 0) return history;
  const reasoningIndices = history.reduce((acc, item, i) => {
    if (item && item.type === "reasoning") acc.push(i);
    return acc;
  }, []);
  if (reasoningIndices.length <= keep) return history;
  const drop = new Set(reasoningIndices.slice(0, reasoningIndices.length - keep));
  return history.filter((_, i) => !drop.has(i));
}

//  Removes function_calls whose arguments will not parse, and the outputs
//  paired to them. Repairing is not attempted: `{` carries no intent to
//  recover, and a guess at what the agent meant to do is worse than the turn
//  simply not being in the record.
function dropBrokenToolCalls(history) {
  if (!Array.isArray(history)) return history;
  const doomed = new Set();
  for (const item of history) {
    if (item?.type !== "function_call") continue;
    try {
      const parsed = JSON.parse(item.arguments ?? "{}");
      if (parsed && typeof parsed === "object") continue;
    } catch (e) { /* falls through to doomed */ }
    if (item.call_id) doomed.add(item.call_id);
  }
  if (!doomed.size) return history;
  const kept = history.filter((item) =>
    !((item?.type === "function_call" || item?.type === "function_call_output")
      && doomed.has(item.call_id)));
  console.warn(`History: dropped ${history.length - kept.length} item(s) from `
    + `${doomed.size} tool call(s) whose arguments were not valid JSON.`);
  return kept;
}

function processHistoryForAPI(currentHistory) {
  const isSystemToolReminder = (message) => {
    if (message.role !== "user" || !message.content || !Array.isArray(message.content)) {
      return false;
    }
    return (
      message.content.length === 1 &&
      message.content[0].type === "input_text" &&
      message.content[0].text ===
        "<system>You must include tools in your response ! Always call 'execute_action' tool with your messages to continue your actions !</system>"
    );
  };

  //  A MALFORMED TOOL CALL IN HISTORY POISONS EVERY LATER REQUEST.
  //
  //  Observed in a live run: one function_call stored with arguments of `{`
  //  -- a single opening brace. It is replayed on every subsequent turn, and
  //  the provider rejects the whole request rather than the one bad item:
  //
  //    "Assistant tool call function.arguments must be valid JSON."   (Phala)
  //    "Expecting property name enclosed in double quotes:
  //     line 1 column 2 (char 1)"                                     (Together)
  //
  //  Char 1 of `{`. The complaint is exact and it is about OUR history, not
  //  about the turn being taken -- which is why it looked intermittent and
  //  provider-specific when it was neither.
  //
  //  A function_call and its function_call_output are a pair, so dropping one
  //  without the other trades this 400 for the orphaned-output 400. Both go.
  currentHistory = dropBrokenToolCalls(currentHistory);
  currentHistory = dropOldReasoning(currentHistory);

  const dataMessageIndices = currentHistory.reduce((acc, message, index) => {
    const isUserDataMessage = message.role && message.role === "user" && !isSystemToolReminder(message);
    const isToolDataMessage = message.type === "function_call_output" && Array.isArray(message.output);
    if (isUserDataMessage || isToolDataMessage) {
      acc.push(index);
    }
    return acc;
  }, []);

  const toolResultIndices = currentHistory.reduce((acc, message, index) => {
    if (message.type === "function_call_output") {
      acc.push(index);
    }
    return acc;
  }, []);

  //  DAEMONS: keepLast(0) has to mean NONE, and slice(-0) means ALL.
  //
  //  -0 === 0 in JavaScript, so `arr.slice(-0)` is `arr.slice(0)` -- the whole
  //  array. Every one of these knobs therefore did the exact opposite of what
  //  its name says at its most useful setting: DAEMONS_KEEP_IMAGES=0 kept
  //  images on EVERY message in the history instead of none of them. I told
  //  Christopher to test with 0 to cut prompt size; it would have silently
  //  ballooned it.
  const keepLast = (arr, n) => (n > 0 ? arr.slice(-n) : []);

  const minimapKeepIndices = new Set(keepLast(dataMessageIndices, config.history.keepLastNUserMessagesWithMinimap));
  const viewMapKeepIndices = new Set(keepLast(dataMessageIndices, config.history.keepLastNUserMessagesWithViewMap));
  const detailedDataKeepIndices = new Set(keepLast(dataMessageIndices, config.history.keepLastNUserMessagesWithDetailedData));
  const imagesKeepIndices = new Set(keepLast(dataMessageIndices, config.history.keepLastNUserMessagesWithImages));
  const toolResultKeepIndices = new Set(keepLast(toolResultIndices, config.history.keepLastNToolFullResults));
  const memoryKeepIndices = new Set(keepLast(dataMessageIndices, config.history.keepLastNUserMessagesWithMemory));
  const pokedexKeepIndices = new Set(keepLast(dataMessageIndices, config.history.keepLastNUserMessagesWithPokedex));

  return currentHistory
    .map((message, index) => {
      let newMessage = JSON.parse(JSON.stringify(message));

      if (newMessage.role === "user") {
        if (isSystemToolReminder(newMessage)) {
          return newMessage;
        }

        let textContentIndex = newMessage.content.findIndex((item) => item.type === "input_text");
        let originalText = textContentIndex !== -1 ? newMessage.content[textContentIndex].text : null;

        if (originalText) {
          let sectionsToRemove = {
            minimap: !minimapKeepIndices.has(index),
            view_map: !viewMapKeepIndices.has(index),
            memory: !memoryKeepIndices.has(index),
            game_area: !detailedDataKeepIndices.has(index),
            player_data: !detailedDataKeepIndices.has(index),
            pokedex_data: !pokedexKeepIndices.has(index),
          };
          newMessage.content[textContentIndex].text = cleanTextSections(originalText, sectionsToRemove);
        }

        if (!imagesKeepIndices.has(index)) {
          newMessage.content = newMessage.content.filter((item) => item.type !== "input_image");
        }
        return newMessage;
      } else if (newMessage.type === "function_call_output") {
        const outputItems = Array.isArray(newMessage.output) ? newMessage.output : null;

        if (outputItems) {
          outputItems.forEach((item, itemIndex) => {
            if (item.type === "input_text" && typeof item.text === "string") {
              const sectionsToRemove = {
                minimap: !minimapKeepIndices.has(index),
                view_map: !viewMapKeepIndices.has(index),
                memory: !memoryKeepIndices.has(index),
                game_area: !detailedDataKeepIndices.has(index),
                player_data: !detailedDataKeepIndices.has(index),
              };
              outputItems[itemIndex].text = cleanTextSections(item.text, sectionsToRemove);
            }
          });

          if (!imagesKeepIndices.has(index)) {
            newMessage.output = outputItems.filter((item) => item.type !== "input_image");
          } else {
            newMessage.output = outputItems;
          }

          if (!toolResultKeepIndices.has(index)) {
            const maxLength = 3200;
            const keepLength = Math.floor(maxLength / 2);
            const firstTextItem = newMessage.output.find(
              (item) => item.type === "input_text" && typeof item.text === "string"
            );
            if (firstTextItem) {
              const text = firstTextItem.text;
              if (text.length > maxLength) {
                firstTextItem.text =
                  text.substring(0, keepLength) +
                  "\n...(truncated)...\n" +
                  text.substring(text.length - keepLength);
              }
            }
          }
        } else if (typeof newMessage.output === "string") {
          if (!toolResultKeepIndices.has(index)) {
            const output = newMessage.output;
            const maxLength = 3200;
            const keepLength = Math.floor(maxLength / 2);
            if (output.length > maxLength) {
              newMessage.output =
                output.substring(0, keepLength) +
                "\n...(truncated)...\n" +
                output.substring(output.length - keepLength);
            }
          }
        }
        return newMessage;
      } else {
        return message;
      }
    })
    .filter((message) => message !== null);
}

module.exports = { cleanTextSections, processHistoryForAPI };

