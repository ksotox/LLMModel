// Printed set codes (the three letters at the bottom-left of a card, e.g. "PAL") mapped to
// TCGdex set ids. The lookup also falls back to matching the printed set total ("066/193"),
// so a set missing from this list can still be found.
export const SET_CODES = {
  // Mega Evolution
  MEG: { id: 'me01', name: 'Mega Evolution', total: 132 },
  PFL: { id: 'me02', name: 'Phantasmal Flames', total: 94 },
  ASC: { id: 'me02.5', name: 'Ascended Heroes', total: 217 },
  POR: { id: 'me03', name: 'Perfect Order', total: 88 },
  CRI: { id: 'me04', name: 'Chaos Rising', total: 86 },
  PBL: { id: 'me05', name: 'Pitch Black', total: 84 },
  // Scarlet & Violet
  SVI: { id: 'sv01', name: 'Scarlet & Violet', total: 198 },
  PAL: { id: 'sv02', name: 'Paldea Evolved', total: 193 },
  OBF: { id: 'sv03', name: 'Obsidian Flames', total: 197 },
  MEW: { id: 'sv03.5', name: '151', total: 165 },
  PAR: { id: 'sv04', name: 'Paradox Rift', total: 182 },
  PAF: { id: 'sv04.5', name: 'Paldean Fates', total: 91 },
  TEF: { id: 'sv05', name: 'Temporal Forces', total: 162 },
  TWM: { id: 'sv06', name: 'Twilight Masquerade', total: 167 },
  SFA: { id: 'sv06.5', name: 'Shrouded Fable', total: 64 },
  SCR: { id: 'sv07', name: 'Stellar Crown', total: 142 },
  SSP: { id: 'sv08', name: 'Surging Sparks', total: 191 },
  PRE: { id: 'sv08.5', name: 'Prismatic Evolutions', total: 131 },
  JTG: { id: 'sv09', name: 'Journey Together', total: 159 },
  DRI: { id: 'sv10', name: 'Destined Rivals', total: 182 },
  BLK: { id: 'sv10.5b', name: 'Black Bolt', total: 86 },
  WHT: { id: 'sv10.5w', name: 'White Flare', total: 86 },
  SVP: { id: 'svp', name: 'SVP Black Star Promos' },
  // Sword & Shield
  SSH: { id: 'swsh1', name: 'Sword & Shield', total: 202 },
  RCL: { id: 'swsh2', name: 'Rebel Clash', total: 192 },
  DAA: { id: 'swsh3', name: 'Darkness Ablaze', total: 189 },
  CPA: { id: 'swsh3.5', name: "Champion's Path", total: 73 },
  VIV: { id: 'swsh4', name: 'Vivid Voltage', total: 185 },
  SHF: { id: 'swsh4.5', name: 'Shining Fates', total: 72 },
  BST: { id: 'swsh5', name: 'Battle Styles', total: 163 },
  CRE: { id: 'swsh6', name: 'Chilling Reign', total: 198 },
  EVS: { id: 'swsh7', name: 'Evolving Skies', total: 203 },
  CEL: { id: 'cel25', name: 'Celebrations', total: 25 },
  FST: { id: 'swsh8', name: 'Fusion Strike', total: 264 },
  BRS: { id: 'swsh9', name: 'Brilliant Stars', total: 172 },
  ASR: { id: 'swsh10', name: 'Astral Radiance', total: 189 },
  LOR: { id: 'swsh11', name: 'Lost Origin', total: 196 },
  SIT: { id: 'swsh12', name: 'Silver Tempest', total: 195 },
  CRZ: { id: 'swsh12.5', name: 'Crown Zenith', total: 159 },
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
