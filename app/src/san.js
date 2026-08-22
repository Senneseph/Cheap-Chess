// san.js — algebraic notation for the UI (and human-facing output).
// Handles castling, disambiguation, captures, promotion, check/checkmate.

import { WHITE, BLACK, P, N, B, R, Q, K, generateLegal, applyMove, inCheck, isCapture, mvFrom, mvTo, mvPiece, mvPromo, squareName } from './board.js';

const LETTERS = { 1: '', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };

export function san(state, move) {
  const piece = mvPiece(move);
  const from = mvFrom(move), to = mvTo(move);
  const flags = (move >> 21) & 7;

  if (flags === 5) return (to === 6 || to === 62) ? 'O-O' : 'O-O-O';

  const next = applyMove(state, move);
  const isCheck = inCheck(next);
  const mates = generateLegal(next).length === 0;

  let s = '';
  if (piece === P) {
    if (isCapture(move)) s += squareName(from)[0] + 'x';
    s += squareName(to);
  } else {
    s += LETTERS[piece];
    // disambiguation
    const ambiguous = [];
    for (const m of generateLegal(state)) {
      if (m === move) continue;
      if (mvPiece(m) === piece && mvTo(m) === to) ambiguous.push(m);
    }
    if (ambiguous.length) {
      const sameFile = ambiguous.some((m) => (mvFrom(m) & 7) === (from & 7));
      const sameRank = ambiguous.some((m) => (mvFrom(m) >> 3) === (from >> 3));
      if (!sameFile) s += squareName(from)[0];
      else if (!sameRank) s += String((from >> 3) + 1);
      else s += squareName(from);
    }
    if (isCapture(move)) s += 'x';
    s += squareName(to);
  }
  const promo = mvPromo(move);
  if (promo) s += '=' + (promo === Q ? 'Q' : promo === R ? 'R' : promo === B ? 'B' : 'N');
  if (mates) s += '#';
  else if (isCheck) s += '+';
  return s;
}

export function sanList(state, moves) {
  return moves.map((m) => san(state, m));
}
