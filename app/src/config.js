// config.js — the tuneable engine profile.
//
// Every knob that changes HOW the engine plays lives here. Two configs are
// different engines: the learner's exception cache is namespaced by a
// fingerprint of this whole object, so knowledge learned under one profile is
// NEVER applied under another (the difficulty remains a per-record dimension).
//
// Scoring scale: 1 pawn = 1000 points. All eval terms use this scale:
// material, center control (10 per potential move into a center square),
// check/threat/trade bonuses, and mateScore ("winning the game").

export const DEFAULT_CONFIG = {
  // material values in pawns: [_, P, N, B, R, Q, K] (king = game, not material)
  // pawn = 1000 points internally, so N/B = 3000, R = 5000, Q = 9000.
  pieceValues: [0, 1, 3, 3, 5, 9, 0],
  // center control: points per POTENTIAL MOVE a piece can make into one of the
  // four center squares (d4 d5 e4 e5). The target square may be empty, enemy
  // occupied, or friendly occupied — every piece that could move there counts.
  // 10 × however many moves = almost always less than a single pawn (1000).
  centerPoints: 10,
  // "antagonizing the king": points when the side to move has the opponent's
  // king in check. The owner never settled a weight; 50 ≈ 0.05 pawns is a
  // gentle nudge toward checking when lines are otherwise equal.
  checkBonus: 50,
  // points per enemy piece the side to move threatens (pseudo-legal)
  threatBonus: 30,
  // points added to safe capture moves at the root ("it likes to trade")
  tradeBonus: 120,
  // the value of "winning the game" (checkmate); must dwarf any material line
  mateScore: 1000000,
  // QUIESCENCE — the "last minute check": when the search hits its depth
  // limit, if captures (or check evasion) are still available, keep searching
  // them until the position is quiet before scoring. Stops the engine from
  // evaluating boards mid-tactic (hanging pieces just past the horizon).
  quiescence: true,
  quiescenceDepth: 6, // max extra plies of capture/evasion resolution
  // KING SAFETY — pawn shield in front of the king, open-file penalties, a
  // castled bonus (so the engine actually castles), and a wandering-king
  // penalty. Board reads only, so quiescence stays cheap.
  kingSafetyPoints: 100,
};

// Convert pawns to points (1 pawn = 1000).
export const PTS = (pawns) => Math.round(pawns * 1000);

// Presets shown in the New Game screen.
export const PRESETS = {
  Classic: { ...DEFAULT_CONFIG }, // the user's spec: 1000-scale material, tiny center
  Trader: { ...DEFAULT_CONFIG, tradeBonus: 300, threatBonus: 80 },
  Center: { ...DEFAULT_CONFIG, centerPoints: 25, threatBonus: 60 },
  Materialist: { ...DEFAULT_CONFIG, centerPoints: 0, checkBonus: 0, threatBonus: 0, tradeBonus: 0 },
};

// Stable fingerprint: JSON + FNV-1a 32-bit. Used as the learner namespace, so
// any change to any knob produces an entirely separate exception cache.
export function configFingerprint(config) {
  const json = JSON.stringify([
    config.pieceValues,
    config.centerPoints,
    config.checkBonus,
    config.threatBonus,
    config.tradeBonus,
    config.mateScore,
    config.quiescence,
    config.quiescenceDepth,
    config.kingSafetyPoints,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function sanitizeConfig(c) {
  const cfg = { ...DEFAULT_CONFIG };
  if (!c) return cfg;
  if (Array.isArray(c.pieceValues) && c.pieceValues.length >= 7) {
    cfg.pieceValues = c.pieceValues.map((v) => Math.max(0, Math.min(50, +v || 0)));
    cfg.pieceValues[0] = 0;
    cfg.pieceValues[6] = 0;
  }
  cfg.centerPoints = Math.max(0, Math.min(100, +c.centerPoints ?? DEFAULT_CONFIG.centerPoints));
  cfg.checkBonus = Math.max(0, Math.min(500, +c.checkBonus ?? DEFAULT_CONFIG.checkBonus));
  cfg.threatBonus = Math.max(0, Math.min(500, +c.threatBonus ?? DEFAULT_CONFIG.threatBonus));
  cfg.tradeBonus = Math.max(0, Math.min(500, +c.tradeBonus ?? DEFAULT_CONFIG.tradeBonus));
  cfg.mateScore = Math.max(10000, Math.min(10000000, +c.mateScore ?? DEFAULT_CONFIG.mateScore));
  cfg.quiescence = c.quiescence !== false;
  cfg.quiescenceDepth = Math.max(0, Math.min(32, +c.quiescenceDepth ?? DEFAULT_CONFIG.quiescenceDepth));
  cfg.kingSafetyPoints = Math.max(0, Math.min(500, +c.kingSafetyPoints ?? DEFAULT_CONFIG.kingSafetyPoints));
  return cfg;
}
