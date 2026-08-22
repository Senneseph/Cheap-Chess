// eval.js — Cheap Chess board scoring, parameterized by an engine profile.
//
// Scale: 1 pawn = 1000 points. All terms are in points, from the side to
// move's perspective:
//
//   material = Σ my piece values − Σ opponent's (pawns × 1000)
//   center   = ±centerPoints per POTENTIAL MOVE a piece can make into one of
//              the four center squares (d4 d5 e4 e5). The target square may be
//              empty, enemy-occupied, or friendly-occupied — every piece that
//              could move there counts, so the whole center stays worth less
//              than a single pawn in practice.
//   check    = +checkBonus if the opponent's king is in check
//   threat   = +threatBonus per enemy piece I attack (pseudo-legal)
//   trade    = +tradeBonus at the ROOT of the search for safe captures
//              (applied in search.js — see specs/engine.md for why it is
//              root-level and not a leaf term)
//
// Mate/stalemate are handled by the search (king = game).

import { WHITE, BLACK, P, N, B, R, Q, K, isAttacked, KNIGHT_OFFS, KING_OFFS, ROOK_DIRS, BISHOP_DIRS } from './board.js';
import { DEFAULT_CONFIG, PTS } from './config.js';
export const PIECE_VALUES = DEFAULT_CONFIG.pieceValues; // (kept for compatibility)
export const CENTER_POINTS = DEFAULT_CONFIG.centerPoints;
export const CENTER_SQUARES = [27, 28, 35, 36]; // d4 e4 d5 e5 (rank-major, a1=0)
export const TRADE_BONUS_CP = DEFAULT_CONFIG.tradeBonus;

export function materialScore(s, config = DEFAULT_CONFIG) {
  const v = config.pieceValues;
  let m = 0;
  const b = s.b;
  for (let i = 0; i < 64; i++) {
    const pc = b[i];
    if (pc > 0) m += v[pc];
    else if (pc < 0) m -= v[-pc];
  }
  return m;
}

// How many pieces of `color` have a POTENTIAL move into square `sq`?
// The target square's contents don't matter (capturing / empty / friendly
// occupied all count); the path must be clear for sliders; a pawn's straight
// push only counts into an empty square (its diagonal capture counts always).
function potentialMovers(s, sq, color) {
  const b = s.b, f = sq & 7, r = sq >> 3;
  let n = 0;
  // pawns
  if (color === WHITE) {
    if (r > 0) {
      const push = sq - 8;
      if (b[push] === P && b[sq] === 0) n++; // straight push (empty target)
      if (f > 0 && sq >= 9 && b[sq - 9] === P) n++; // diagonal capture pattern
      if (f < 7 && sq >= 7 && b[sq - 7] === P) n++;
    }
    if (r === 3) { // double push into a rank-4 center square (d4/e4)
      if (b[sq - 16] === P && b[sq - 8] === 0 && b[sq] === 0) n++;
    }
  } else {
    if (r < 7) {
      const push = sq + 8;
      if (b[push] === -P && b[sq] === 0) n++;
      if (f < 7 && sq <= 54 && b[sq + 9] === -P) n++;
      if (f > 0 && sq <= 56 && b[sq + 7] === -P) n++;
    }
    if (r === 4) { // double push into a rank-5 center square (d5/e5)
      if (b[sq + 16] === -P && b[sq + 8] === 0 && b[sq] === 0) n++;
    }
  }
  // knights
  for (const o of KNIGHT_OFFS) {
    const t = sq + o;
    if (t >= 0 && t < 64 && Math.abs((t & 7) - f) <= 2 && b[t] === color * N) n++;
  }
  // king
  for (const o of KING_OFFS) {
    const t = sq + o;
    if (t >= 0 && t < 64 && ((t & 7) - f) >= -1 && ((t & 7) - f) <= 1 && b[t] === color * K) n++;
  }
  // sliders: walk rays from sq; the first piece on the ray must be a friendly
  // slider of the matching type (i.e., the path to sq is clear)
  for (const d of ROOK_DIRS) {
    let t = sq + d, steps = 1;
    while (t >= 0 && t < 64 && (d === 1 || d === -1 ? (t & 7) === f + d * steps : (t >> 3) === r + (d > 0 ? 1 : -1) * steps)) {
      const pc = b[t];
      if (pc !== 0) { if (pc === color * R || pc === color * Q) n++; break; }
      steps++; t = sq + d * steps;
    }
  }
  for (const d of BISHOP_DIRS) {
    const df = (d === 7 || d === -9) ? -1 : 1;
    let t = sq + d, steps = 0;
    while (t >= 0 && t < 64 && (t & 7) === f + df * (steps + 1) && (t >> 3) === r + (d > 0 ? 1 : -1) * (steps + 1)) {
      const pc = b[t];
      if (pc !== 0) { if (pc === color * B || pc === color * Q) n++; break; }
      steps++; t = sq + d * (steps + 1);
    }
  }
  return n;
}

export function centerScore(s, config = DEFAULT_CONFIG) {
  if (!config.centerPoints) return 0;
  let n = 0;
  for (const sq of CENTER_SQUARES) {
    n += potentialMovers(s, sq, s.turn) - potentialMovers(s, sq, -s.turn);
  }
  return n * config.centerPoints;
}

// "Piece threatening": +threatBonus per enemy piece I attack (pseudo-legal).
export function threatScore(s, config = DEFAULT_CONFIG) {
  if (!config.threatBonus) return 0;
  let n = 0;
  const b = s.b;
  for (let sq = 0; sq < 64; sq++) {
    const pc = b[sq];
    if (pc !== 0 && Math.sign(pc) === -s.turn && isAttacked(b, sq, s.turn)) n++;
  }
  return n * config.threatBonus;
}

// "Check threatening": +checkBonus when the opponent's king is in check.
export function checkScore(s, config = DEFAULT_CONFIG) {
  if (!config.checkBonus) return 0;
  const ksq = s.turn === WHITE ? s.bksq : s.wksq;
  return isAttacked(s.b, ksq, s.turn) ? config.checkBonus : 0;
}

// ---- king safety ----------------------------------------------------------
// Cheap, transparent, board-reads only (no attack tests — quiescence keeps
// its speed). Four sub-terms, all scaled by the one `kingSafetyPoints` knob:
//   pawn shield   +2 per friendly pawn on the 3 files around the king, on the
//                 king's rank and the two ranks in front of it
//   open files    -3 per adjacent file (king's + neighbors) with no friendly pawn
//   castled       +5 when the king is on the g/b file on the back rank
//                 (this is what makes the engine actually castle)
//   centered      -4 when the king sits on the d/e files off its back rank
//                 (the "wandering king" penalty)
function rawKingSafety(s, color) {
  const k = color === WHITE ? s.wksq : s.bksq;
  const kf = k & 7, kr = k >> 3;
  const dir = color === WHITE ? 1 : -1;
  const pawn = color * P;
  let shield = 0;
  for (let df = -1; df <= 1; df++) {
    const f = kf + df;
    if (f < 0 || f > 7) continue;
    for (let step = 0; step <= 2; step++) {
      const r = kr + dir * step;
      if (r < 0 || r > 7) continue;
      if (s.b[r * 8 + f] === pawn) shield++;
    }
  }
  let openFiles = 0;
  for (let df = -1; df <= 1; df++) {
    const f = kf + df;
    if (f < 0 || f > 7) continue;
    let has = false;
    for (let r = 0; r < 8; r++) if (s.b[r * 8 + f] === pawn) { has = true; break; }
    if (!has) openFiles++;
  }
  const castled = (kf === 6 || kf === 1) && (kr === 0 || kr === 7);
  const centered = (kf === 3 || kf === 4) && kr !== 0 && kr !== 7;
  return shield * 2 - openFiles * 3 + (castled ? 5 : 0) - (centered ? 4 : 0);
}

export function kingSafetyScore(s, config = DEFAULT_CONFIG) {
  if (!config.kingSafetyPoints) return 0;
  const mine = rawKingSafety(s, s.turn);
  const theirs = rawKingSafety(s, -s.turn);
  return Math.round((config.kingSafetyPoints * (mine - theirs)) / 10);
}

// Static evaluation in points (1 pawn = 1000), from the side to move's perspective.
export function evaluate(s, config = DEFAULT_CONFIG) {
  const mat = (s.turn === WHITE ? 1 : -1) * materialScore(s, config);
  return PTS(mat) + centerScore(s, config) + checkScore(s, config) + threatScore(s, config) + kingSafetyScore(s, config);
}

// Human-friendly display: +0.75 means the side to move is ahead 0.75 pawns.
export function formatScore(points) {
  const v = points / 1000;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}
