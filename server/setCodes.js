// Printed set codes (the three letters at the bottom-left of a card, e.g. "PAL") mapped to
// TCGdex set ids, plus each set's TCGplayer group id (from TCGdex's data files), which finds the
// set on tcgcsv.com for backup prices and pictures. The lookup also falls back to matching the printed set total ("066/193"),
// so a set missing from this list can still be found.
export const SET_CODES = {
  // Mega Evolution
  MEG: { id: 'me01', name: 'Mega Evolution', total: 132, tcgplayer: 24380 },
  PFL: { id: 'me02', name: 'Phantasmal Flames', total: 94, tcgplayer: 24448 },
  ASC: { id: 'me02.5', name: 'Ascended Heroes', total: 217, tcgplayer: 24541 },
  POR: { id: 'me03', name: 'Perfect Order', total: 88, tcgplayer: 24587 },
  CRI: { id: 'me04', name: 'Chaos Rising', total: 86, tcgplayer: 24655 },
  PBL: { id: 'me05', name: 'Pitch Black', total: 84, tcgplayer: 24688 },
  '30C': { id: '30th', name: '30th Celebration', total: 128, tcgplayer: 24722 },
  MEP: { id: 'mep', name: 'MEP Black Star Promos', tcgplayer: 24451 },
  // Scarlet & Violet
  SVI: { id: 'sv01', name: 'Scarlet & Violet', total: 198, tcgplayer: 22873 },
  PAL: { id: 'sv02', name: 'Paldea Evolved', total: 193, tcgplayer: 23120 },
  OBF: { id: 'sv03', name: 'Obsidian Flames', total: 197, tcgplayer: 23228 },
  MEW: { id: 'sv03.5', name: '151', total: 165, tcgplayer: 23237 },
  PAR: { id: 'sv04', name: 'Paradox Rift', total: 182, tcgplayer: 23286 },
  PAF: { id: 'sv04.5', name: 'Paldean Fates', total: 91, tcgplayer: 23353 },
  TEF: { id: 'sv05', name: 'Temporal Forces', total: 162, tcgplayer: 23381 },
  TWM: { id: 'sv06', name: 'Twilight Masquerade', total: 167, tcgplayer: 23473 },
  SFA: { id: 'sv06.5', name: 'Shrouded Fable', total: 64, tcgplayer: 23529 },
  SCR: { id: 'sv07', name: 'Stellar Crown', total: 142, tcgplayer: 23537 },
  SSP: { id: 'sv08', name: 'Surging Sparks', total: 191, tcgplayer: 23651 },
  PRE: { id: 'sv08.5', name: 'Prismatic Evolutions', total: 131, tcgplayer: 23821 },
  JTG: { id: 'sv09', name: 'Journey Together', total: 159, tcgplayer: 24073 },
  DRI: { id: 'sv10', name: 'Destined Rivals', total: 182, tcgplayer: 24269 },
  BLK: { id: 'sv10.5b', name: 'Black Bolt', total: 86, tcgplayer: 24325 },
  WHT: { id: 'sv10.5w', name: 'White Flare', total: 86, tcgplayer: 24326 },
  SVP: { id: 'svp', name: 'SVP Black Star Promos', tcgplayer: 22872 },
  // Sword & Shield
  SSH: { id: 'swsh1', name: 'Sword & Shield', total: 202, tcgplayer: 2585 },
  RCL: { id: 'swsh2', name: 'Rebel Clash', total: 192, tcgplayer: 2626 },
  DAA: { id: 'swsh3', name: 'Darkness Ablaze', total: 189, tcgplayer: 2675 },
  CPA: { id: 'swsh3.5', name: "Champion's Path", total: 73, tcgplayer: 2685 },
  VIV: { id: 'swsh4', name: 'Vivid Voltage', total: 185, tcgplayer: 2701 },
  SHF: { id: 'swsh4.5', name: 'Shining Fates', total: 72, tcgplayer: 2754 },
  BST: { id: 'swsh5', name: 'Battle Styles', total: 163, tcgplayer: 2765 },
  CRE: { id: 'swsh6', name: 'Chilling Reign', total: 198, tcgplayer: 2807 },
  EVS: { id: 'swsh7', name: 'Evolving Skies', total: 203, tcgplayer: 2848 },
  CEL: { id: 'cel25', name: 'Celebrations', total: 25, tcgplayer: 2867 },
  FST: { id: 'swsh8', name: 'Fusion Strike', total: 264, tcgplayer: 2906 },
  BRS: { id: 'swsh9', name: 'Brilliant Stars', total: 172, tcgplayer: 2948 },
  ASR: { id: 'swsh10', name: 'Astral Radiance', total: 189, tcgplayer: 3040 },
  LOR: { id: 'swsh11', name: 'Lost Origin', total: 196, tcgplayer: 3118 },
  SIT: { id: 'swsh12', name: 'Silver Tempest', total: 195, tcgplayer: 3170 },
  CRZ: { id: 'swsh12.5', name: 'Crown Zenith', total: 159, tcgplayer: 17688 },
};

export function setFromCode(code) {
  return SET_CODES[String(code ?? '').trim().toUpperCase()] ?? null;
}

export function codeFromSetId(setId) {
  for (const [code, set] of Object.entries(SET_CODES)) if (set.id === setId) return code;
  return null;
}

/** "066/193" -> { localId: "066", total: "193" }; "TG05" -> { localId: "TG05", total: null } */
export function parseNumber(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { localId: null, total: null };
  const [localId, total] = raw.split('/').map((s) => s.trim());
  return { localId: localId || null, total: total || null };
}

/** Compare card numbers loosely: "066" == "66", "TG05" == "tg5". */
export function sameNumber(a, b) {
  if (a == null || b == null) return false;
  const norm = (s) => String(s).trim().toUpperCase().replace(/^([A-Z]*)0*(\d)/, '$1$2');
  return norm(a) === norm(b);
}
