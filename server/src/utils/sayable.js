// BRAIN: cortex.motor (voice) -- words respelled for the voice: phonological encoding (as the companion's say.ts)
//  DAEMONS (T-618): the words a voice is handed, never the words shown or kept. DAEMONS is said DAY-mons, and a voice
//  reads the spelling as the frightening word, so every line spoken is respelled daymon(s) first. The same rule as the
//  companion's server/src/machine/say.ts, word for word: capitals come out Daymon (never DAYMON, which a voice may
//  spell out), a word ending in daemon keeps its front (eudaemon -> eudaymon), daemonic is left alone, and respelled
//  twice a line is unchanged.
function sayable(text) {
  return String(text).replace(/\b(\w*?)daemon(s?)\b/gi, (w) => {
    const said = w.toLowerCase().replace(/daemon(s?)$/, "daymon$1");
    return w[0] === w[0].toLowerCase() ? said : said[0].toUpperCase() + said.slice(1);
  });
}

module.exports = { sayable };
