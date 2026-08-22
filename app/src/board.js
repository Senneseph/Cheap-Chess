// board.js — Cheap Chess rules engine.
// Mailbox 64 (a1=0 .. h8=63), no bitboards, incremental 64-bit Zobrist keys
// (stored as two int32 halves for speed).
//
// Pieces are signed: positive = white, negative = black.
//   P=1 N=2 B=3 R=4 Q=5 K=6
//
// A move is a packed int32:
//   from(6) | to(6) | promo(3) | captured(3) | piece(3) | flags(3)
// Promo/captured/piece use the unsigned piece codes 1..6 (0 = none).
//
// This module is DOM-free and runs in the browser, a worker, or Node.

export const WHITE = 1;
export const BLACK = -1;
export const EMPTY = 0;
export const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;

export const PIECE_CHARS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

export const FLAG_QUIET = 1, FLAG_CAP = 2, FLAG_DOUBLE = 3, FLAG_EP = 4, FLAG_CASTLE = 5, FLAG_PROMO = 6;

// Castling rights bitmask
export const CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8;

// ---------------------------------------------------------------- squares

export const sqFile = (s) => s & 7;
export const sqRank = (s) => s >> 3;
export const squareName = (s) => 'abcdefgh'[s & 7] + String((s >> 3) + 1);
export function parseSquare(name) {
  const f = name.charCodeAt(0) - 97, r = +name[1] - 1;
  return r * 8 + f;
}
export const FILES = 'abcdefgh';

// ---------------------------------------------------------------- zobrist

const PIECE_KEY_N = 12 * 64;
const TURN_KEY = PIECE_KEY_N;
const CASTLE_KEY = PIECE_KEY_N + 1; // 16 entries (indexed by rights mask)
const EP_KEY = PIECE_KEY_N + 17;    // 9 entries (file 0..7, 8 = none)
const Z_SIZE = PIECE_KEY_N + 26;

const Z1 = new Int32Array(Z_SIZE);
const Z2 = new Int32Array(Z_SIZE);
let zobristReady = false;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

export function initZobrist(seed = 0xc0ffee42) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < Z_SIZE; i++) {
    Z1[i] = rnd() | 0;
    Z2[i] = rnd() | 0;
  }
  zobristReady = true;
}
function ensureZ() { if (!zobristReady) initZobrist(); }

function pk(signedPiece, sq) {
  const color = signedPiece > 0 ? 0 : 6;
  const pc = Math.abs(signedPiece);
  return (color * 6 + (pc - 1)) * 64 + sq;
}

// Compute a state's keys from scratch: pieces + side + castling rights + ep.
// MUST match the incremental path (applyMove), or the same position gets
// different keys depending on how it was constructed (which broke the
// learner's zobrist lookups). Convention: the turn key is present iff it is
// WHITE to move (the incremental path starts with it and toggles per move).
function initKeys(s) {
  ensureZ();
  s.k1 = s.k2 = 0;
  for (let sq = 0; sq < 64; sq++) {
    const pc = s.b[sq];
    if (pc) { s.k1 ^= Z1[pk(pc, sq)]; s.k2 ^= Z2[pk(pc, sq)]; }
  }
  if (s.turn === WHITE) { s.k1 ^= Z1[TURN_KEY]; s.k2 ^= Z2[TURN_KEY]; }
  s.k1 ^= Z1[CASTLE_KEY + s.rights]; s.k2 ^= Z2[CASTLE_KEY + s.rights];
  if (s.ep >= 0) { s.k1 ^= Z1[EP_KEY + sqFile(s.ep)]; s.k2 ^= Z2[EP_KEY + sqFile(s.ep)]; }
}

// ---------------------------------------------------------------- state

export function makeState() {
  return {
    b: new Int8Array(64),
    turn: WHITE,
    rights: 0,
    ep: -1,
    half: 0,
    full: 1,
    wksq: -1, bksq: -1,
    k1: 0, k2: 0,
  };
}

export function startState() {
  ensureZ();
  const s = makeState();
  s.rights = CR_WK | CR_WQ | CR_BK | CR_BQ;
  const back = [R, N, B, Q, K, B, N, R];
  for (let f = 0; f < 8; f++) {
    s.b[f] = back[f];            // rank 1 (white back rank)
    s.b[8 + f] = P;              // rank 2
    s.b[48 + f] = -P;            // rank 7
    s.b[56 + f] = -back[f];      // rank 8
  }
  s.wksq = 4; s.bksq = 60;
  initKeys(s);
  return s;
}

export function cloneState(s) {
  const n = { ...s, b: new Int8Array(s.b) };
  return n;
}

// ---------------------------------------------------------------- FEN

export function stateToFen(s, compact = false) {
  let placement = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const pc = s.b[r * 8 + f];
      if (pc === 0) { empty++; continue; }
      if (empty) { placement += empty; empty = 0; }
      placement += pc > 0 ? PIECE_CHARS[pc].toUpperCase() : PIECE_CHARS[-pc];
    }
    if (empty) placement += empty;
    if (r > 0) placement += '/';
  }
  const turn = s.turn === WHITE ? 'w' : 'b';
  let castling = '';
  if (s.rights & CR_WK) castling += 'K';
  if (s.rights & CR_WQ) castling += 'Q';
  if (s.rights & CR_BK) castling += 'k';
  if (s.rights & CR_BQ) castling += 'q';
  if (!castling) castling = '-';
  const ep = s.ep >= 0 ? squareName(s.ep) : '-';
  if (compact) return `${placement} ${turn} ${castling} ${ep}`;
  return `${placement} ${turn} ${castling} ${ep} ${s.half} ${s.full}`;
}

export function fenToState(fen) {
  ensureZ();
  const parts = fen.trim().split(/\s+/);
  const [placement, turn, castling, ep] = parts;
  const s = makeState();
  s.turn = turn === 'b' ? BLACK : WHITE;
  if (castling && castling !== '-') {
    if (castling.includes('K')) s.rights |= CR_WK;
    if (castling.includes('Q')) s.rights |= CR_WQ;
    if (castling.includes('k')) s.rights |= CR_BK;
    if (castling.includes('q')) s.rights |= CR_BQ;
  }
  s.ep = ep && ep !== '-' ? parseSquare(ep) : -1;
  s.half = parts.length > 4 ? +parts[4] : 0;
  s.full = parts.length > 5 ? +parts[5] : 1;
  let r = 7, f = 0;
  for (const ch of placement) {
    if (ch === '/') { r--; f = 0; continue; }
    if (ch >= '1' && ch <= '8') { f += +ch; continue; }
    const lower = ch.toLowerCase();
    const pc = PIECE_CHARS.indexOf(lower);
    const color = ch === lower ? BLACK : WHITE;
    s.b[r * 8 + f] = pc * color;
    if (pc === K) { if (color === WHITE) s.wksq = r * 8 + f; else s.bksq = r * 8 + f; }
    f++;
  }
  // compute key (pieces + turn + castling + ep — consistent with applyMove)
  initKeys(s);
  return s;
}

// Compact position identity used for repetition & learner exceptions:
// normalized so an en-passant square that cannot be captured is treated as '-' 
// (FIDE repetition semantics). The piece key + turn + castling + ep(file) fully
// identify a position for our purposes.
export function positionKey(s) {
  const ep = canEnPassant(s) ? squareName(s.ep) : '-';
  const turn = s.turn === WHITE ? 'w' : 'b';
  let castling = '';
  if (s.rights & CR_WK) castling += 'K';
  if (s.rights & CR_WQ) castling += 'Q';
  if (s.rights & CR_BK) castling += 'k';
  if (s.rights & CR_BQ) castling += 'q';
  if (!castling) castling = '-';
  return `${stateToFen(s, true).split(' ')[0]} ${turn} ${castling} ${ep}`;
}

// ---------------------------------------------------------------- attack

export const KNIGHT_OFFS = [17, 15, 10, 6, -6, -10, -15, -17];
export const KING_OFFS = [1, 7, 8, 9, -1, -7, -8, -9];
export const ROOK_DIRS = [1, -1, 8, -8];
export const BISHOP_DIRS = [7, -7, 9, -9];

export function isAttacked(b, sq, byColor) {
  const f = sq & 7;
  // pawns
  if (byColor === WHITE) {
    if (f > 0 && sq >= 9 && b[sq - 9] === P) return true;
    if (f < 7 && sq >= 7 && b[sq - 7] === P) return true;
  } else {
    if (f < 7 && sq <= 54 && b[sq + 9] === -P) return true;
    if (f > 0 && sq <= 56 && b[sq + 7] === -P) return true;
  }
  // knights
  for (const o of KNIGHT_OFFS) {
    const t = sq + o;
    if (t < 0 || t > 63) continue;
    const df = (t & 7) - f;
    if (Math.abs(df) > 2) continue;
    if (b[t] === byColor * N) return true;
  }
  // king
  for (const o of KING_OFFS) {
    const t = sq + o;
    if (t < 0 || t > 63) continue;
    const df = (t & 7) - f;
    if (df < -1 || df > 1) continue;
    if (b[t] === byColor * K) return true;
  }
  // rook / bishop sliders
  for (const d of ROOK_DIRS) {
    let t = sq + d;
    let steps = 1;
    while (t >= 0 && t < 64 && (d === 1 || d === -1
      ? (t & 7) === f + d * steps              // horizontal: same rank, one file per step
      : (t >> 3) === (sq >> 3) + (d > 0 ? 1 : -1) * steps)) { // vertical: same file, one rank per step
      const pc = b[t];
      if (pc !== 0) {
        if (pc === byColor * R || pc === byColor * Q) return true;
        break;
      }
      steps++; t = sq + d * steps;
    }
  }
  for (const d of BISHOP_DIRS) {
    let t = sq + d;
    const df = (d === 7 || d === -9) ? -1 : 1; // file delta of this diagonal step
    let steps = 0;
    while (t >= 0 && t < 64 && ((t & 7) - f) === df * (steps + 1) && ((t >> 3) - (sq >> 3)) === (d > 0 ? 1 : -1) * (steps + 1)) {
      const pc = b[t];
      if (pc !== 0) {
        if (pc === byColor * B || pc === byColor * Q) return true;
        break;
      }
      steps++; t = sq + d * (steps + 1);
    }
  }
  return false;
}

export function inCheck(s) {
  return isAttacked(s.b, s.turn === WHITE ? s.wksq : s.bksq, -s.turn);
}

// ---------------------------------------------------------------- moves

export const mvFrom = (m) => m & 63;
export const mvTo = (m) => (m >> 6) & 63;
export const mvPromo = (m) => (m >> 12) & 7;
export const mvCaptured = (m) => (m >> 15) & 7;
export const mvPiece = (m) => (m >> 18) & 7;
export const mvFlags = (m) => (m >> 21) & 7;

export function packMove(from, to, piece, captured, promo, flags) {
  return from | (to << 6) | (promo << 12) | (captured << 15) | (piece << 18) | (flags << 21);
}
export const isCapture = (m) => {
  const flags = mvFlags(m);
  return flags === FLAG_CAP || flags === FLAG_EP || (flags === FLAG_PROMO && mvCaptured(m) !== 0);
};
export const uciName = (m) => {
  const p = mvPromo(m);
  return squareName(mvFrom(m)) + squareName(mvTo(m)) + (p ? PIECE_CHARS[p] : '');
};

export function parseUciMove(name) {
  if (name.length < 4) return 0;
  const from = parseSquare(name.slice(0, 2));
  const to = parseSquare(name.slice(2, 4));
  let promo = 0;
  if (name.length > 4) promo = PIECE_CHARS.indexOf(name[4]);
  return packMove(from, to, 0, 0, promo, 0);
}

function canEnPassant(s) {
  if (s.ep < 0) return false;
  const f = sqFile(s.ep);
  const rank = s.turn === WHITE ? 4 : 3; // white ep targets rank 5 (index 4), black rank 4 (index 3)
  if (sqRank(s.ep) !== rank) return false;
  for (const df of [-1, 1]) {
    const ff = f + df;
    if (ff < 0 || ff > 7) continue;
    const sq = s.ep - 8 * s.turn + df; // enemy pawn square
    if (sq >= 0 && sq < 64 && s.b[sq] === -s.turn * P) return true;
  }
  return false;
}

export function generatePseudo(s, out = []) {
  const turn = s.turn;
  const mine = turn;
  for (let sq = 0; sq < 64; sq++) {
    const pc = s.b[sq];
    if (pc === 0 || Math.sign(pc) !== turn) continue;
    const piece = Math.abs(pc);
    const f = sq & 7, r = sq >> 3;
    if (piece === P) {
      const dir = turn === WHITE ? 8 : -8;
      const promoRank = turn === WHITE ? 6 : 1;
      // push
      let t = sq + dir;
      if (t >= 0 && t < 64 && s.b[t] === 0) {
        if (r === promoRank) {
          for (const p of [Q, R, B, N]) out.push(packMove(sq, t, piece, 0, p, FLAG_PROMO));
        } else {
          out.push(packMove(sq, t, piece, 0, 0, FLAG_QUIET));
          // double push
          const startRank = turn === WHITE ? 1 : 6;
          if (r === startRank) {
            const t2 = sq + 2 * dir;
            if (s.b[t2] === 0) out.push(packMove(sq, t2, piece, 0, 0, FLAG_DOUBLE));
          }
        }
      }
      // captures
      for (const df of [-1, 1]) {
        const tf = f + df;
        if (tf < 0 || tf > 7) continue;
        const t = sq + dir + df;
        if (t < 0 || t > 63) continue;
        const victim = s.b[t];
        if (victim !== 0 && Math.sign(victim) !== turn) {
          if (r === promoRank) {
            for (const p of [Q, R, B, N]) out.push(packMove(sq, t, piece, Math.abs(victim), p, FLAG_PROMO));
          } else {
            out.push(packMove(sq, t, piece, Math.abs(victim), 0, FLAG_CAP));
          }
        } else if (t === s.ep && s.b[t] === 0) {
          out.push(packMove(sq, t, piece, P, 0, FLAG_EP));
        }
      }
    } else if (piece === N) {
      for (const o of KNIGHT_OFFS) {
        const t = sq + o;
        if (t < 0 || t > 63) continue;
        const df = (t & 7) - f;
        if (Math.abs(df) > 2) continue;
        const victim = s.b[t];
        if (victim === 0) out.push(packMove(sq, t, piece, 0, 0, FLAG_QUIET));
        else if (Math.sign(victim) !== turn) out.push(packMove(sq, t, piece, Math.abs(victim), 0, FLAG_CAP));
      }
    } else if (piece === K) {
      for (const o of KING_OFFS) {
        const t = sq + o;
        if (t < 0 || t > 63) continue;
        const df = (t & 7) - f;
        if (df < -1 || df > 1) continue;
        const victim = s.b[t];
        if (victim === 0) out.push(packMove(sq, t, piece, 0, 0, FLAG_QUIET));
        else if (Math.sign(victim) !== turn) out.push(packMove(sq, t, piece, Math.abs(victim), 0, FLAG_CAP));
      }
      // castling
      const enemy = -turn;
      if (turn === WHITE && sq === 4) {
        if ((s.rights & CR_WK) && s.b[5] === 0 && s.b[6] === 0 && s.b[7] === R &&
            !isAttacked(s.b, 4, enemy) && !isAttacked(s.b, 5, enemy) && !isAttacked(s.b, 6, enemy)) {
          out.push(packMove(4, 6, K, 0, 0, FLAG_CASTLE));
        }
        if ((s.rights & CR_WQ) && s.b[3] === 0 && s.b[2] === 0 && s.b[1] === 0 && s.b[0] === R &&
            !isAttacked(s.b, 4, enemy) && !isAttacked(s.b, 3, enemy) && !isAttacked(s.b, 2, enemy)) {
          out.push(packMove(4, 2, K, 0, 0, FLAG_CASTLE));
        }
      } else if (turn === BLACK && sq === 60) {
        if ((s.rights & CR_BK) && s.b[61] === 0 && s.b[62] === 0 && s.b[63] === -R &&
            !isAttacked(s.b, 60, enemy) && !isAttacked(s.b, 61, enemy) && !isAttacked(s.b, 62, enemy)) {
          out.push(packMove(60, 62, K, 0, 0, FLAG_CASTLE));
        }
        if ((s.rights & CR_BQ) && s.b[59] === 0 && s.b[58] === 0 && s.b[57] === 0 && s.b[56] === -R &&
            !isAttacked(s.b, 60, enemy) && !isAttacked(s.b, 59, enemy) && !isAttacked(s.b, 58, enemy)) {
          out.push(packMove(60, 58, K, 0, 0, FLAG_CASTLE));
        }
      }
    } else { // sliders
      const dirs = piece === R ? ROOK_DIRS : piece === B ? BISHOP_DIRS : piece === Q ? [...ROOK_DIRS, ...BISHOP_DIRS] : [];
      for (const d of dirs) {
        let t = sq + d;
        let steps = 1;
        while (t >= 0 && t < 64) {
          if (piece === R || piece === Q) {
            if (d === 1 || d === -1) { if ((t & 7) !== (f + d * steps)) break; }
            else if ((t >> 3) !== (r + (d > 0 ? 1 : -1) * steps)) break;
          } else {
            const df = (d === 7 || d === -9) ? -1 : 1;
            if ((t & 7) !== f + df * steps) break;
            if ((t >> 3) !== r + (d > 0 ? 1 : -1) * steps) break;
          }
          const victim = s.b[t];
          if (victim === 0) out.push(packMove(sq, t, piece, 0, 0, FLAG_QUIET));
          else {
            if (Math.sign(victim) !== turn) out.push(packMove(sq, t, piece, Math.abs(victim), 0, FLAG_CAP));
            break;
          }
          t = sq + d * (++steps);
        }
      }
    }
  }
  return out;
}

// Apply a move, returning a NEW state (search copies; the game layer uses it directly).
export function applyMove(s, m) {
  ensureZ(); // guard: incremental keys need the zobrist tables initialized
  const n = cloneState(s);
  const turn = s.turn;
  const f = mvFrom(m), t = mvTo(m);
  const piece = mvPiece(m), captured = mvCaptured(m), promo = mvPromo(m), flags = mvFlags(m);
  const signedPiece = piece * turn;

  // remove mover from origin
  n.b[f] = 0;
  n.k1 ^= Z1[pk(signedPiece, f)]; n.k2 ^= Z2[pk(signedPiece, f)];

  // remove captured piece
  let victimSq = -1;
  if (flags === FLAG_EP) {
    victimSq = t - 8 * turn;
    n.b[victimSq] = 0;
    n.k1 ^= Z1[pk(-turn * P, victimSq)]; n.k2 ^= Z2[pk(-turn * P, victimSq)];
  } else if (captured) {
    n.b[t] = 0;
    n.k1 ^= Z1[pk(-turn * captured, t)]; n.k2 ^= Z2[pk(-turn * captured, t)];
  }

  // place mover (or promoted piece)
  const placed = promo ? promo * turn : signedPiece;
  n.b[t] = placed;
  n.k1 ^= Z1[pk(placed, t)]; n.k2 ^= Z2[pk(placed, t)];

  // castling rook
  if (flags === FLAG_CASTLE) {
    let rookFrom, rookTo;
    if (t === 6) { rookFrom = 7; rookTo = 5; }
    else if (t === 2) { rookFrom = 0; rookTo = 3; }
    else if (t === 62) { rookFrom = 63; rookTo = 61; }
    else { rookFrom = 56; rookTo = 59; }
    const sr = turn * R;
    n.b[rookFrom] = 0; n.b[rookTo] = sr;
    n.k1 ^= Z1[pk(sr, rookFrom)]; n.k2 ^= Z2[pk(sr, rookFrom)];
    n.k1 ^= Z1[pk(sr, rookTo)]; n.k2 ^= Z2[pk(sr, rookTo)];
  }

  // castling rights
  const oldRights = n.rights;
  if (piece === K) n.rights &= turn === WHITE ? ~(CR_WK | CR_WQ) : ~(CR_BK | CR_BQ);
  if (piece === R) {
    if (f === 0) n.rights &= ~CR_WQ;
    else if (f === 7) n.rights &= ~CR_WK;
    else if (f === 56) n.rights &= ~CR_BQ;
    else if (f === 63) n.rights &= ~CR_BK;
  }
  if (captured) {
    if (t === 0) n.rights &= ~CR_WQ;
    else if (t === 7) n.rights &= ~CR_WK;
    else if (t === 56) n.rights &= ~CR_BQ;
    else if (t === 63) n.rights &= ~CR_BK;
  }
  if (n.rights !== oldRights) {
    n.k1 ^= Z1[CASTLE_KEY + oldRights]; n.k2 ^= Z2[CASTLE_KEY + oldRights];
    n.k1 ^= Z1[CASTLE_KEY + n.rights]; n.k2 ^= Z2[CASTLE_KEY + n.rights];
  }

  // en passant
  if (n.ep >= 0) { n.k1 ^= Z1[EP_KEY + sqFile(n.ep)]; n.k2 ^= Z2[EP_KEY + sqFile(n.ep)]; }
  if (flags === FLAG_DOUBLE) {
    const epSq = (f + t) >> 1;
    // only set ep if an enemy pawn can capture it (normalized repetition semantics)
    n.ep = -1;
    const rank = turn === WHITE ? 2 : 5; // ep square rank
    if (sqRank(epSq) === rank) {
      const f0 = sqFile(epSq);
      for (const df of [-1, 1]) {
        const ff = f0 + df;
        if (ff < 0 || ff > 7) continue;
        const cand = epSq + 8 * turn + df; // enemy pawn that could capture e.p.
        if (cand >= 0 && cand < 64 && n.b[cand] === -turn * P) { n.ep = epSq; break; }
      }
    }
    if (n.ep >= 0) { n.k1 ^= Z1[EP_KEY + sqFile(n.ep)]; n.k2 ^= Z2[EP_KEY + sqFile(n.ep)]; }
  } else {
    n.ep = -1;
  }

  // clocks
  n.half = (piece === P || captured) ? 0 : s.half + 1;
  if (turn === BLACK) n.full = s.full + 1;

  // king squares
  if (piece === K) {
    if (turn === WHITE) n.wksq = t; else n.bksq = t;
  }

  // side to move
  n.turn = -turn;
  n.k1 ^= Z1[TURN_KEY]; n.k2 ^= Z2[TURN_KEY];
  return n;
}

export function generateLegal(s, out = []) {
  const pseudo = generatePseudo(s, out);
  const res = [];
  const mover = s.turn;
  for (const m of pseudo) {
    const n = applyMove(s, m);
    // legal iff the MOVER's king is not attacked by the opponent after the move
    if (!isAttacked(n.b, mover === WHITE ? n.wksq : n.bksq, -mover)) res.push(m);
  }
  return res;
}

// Captures-only legal moves — the quiescence search fast path ("last minute
// check to avoid bad situations"). Dedicated generator (no quiet moves), same
// legality filtering as generateLegal.
export function generateCaptures(s, out = []) {
  const turn = s.turn;
  for (let sq = 0; sq < 64; sq++) {
    const pc = s.b[sq];
    if (pc === 0 || Math.sign(pc) !== turn) continue;
    const piece = Math.abs(pc);
    const f = sq & 7, r = sq >> 3;
    if (piece === P) {
      const dir = turn === WHITE ? 8 : -8;
      const promoRank = turn === WHITE ? 6 : 1;
      for (const df of [-1, 1]) {
        const tf = f + df;
        if (tf < 0 || tf > 7) continue;
        const t = sq + dir + df;
        if (t < 0 || t > 63) continue;
        const victim = s.b[t];
        if (victim !== 0 && Math.sign(victim) !== turn) {
          if (r === promoRank) for (const p of [Q, R, B, N]) out.push(packMove(sq, t, piece, Math.abs(victim), p, FLAG_PROMO));
          else out.push(packMove(sq, t, piece, Math.abs(victim), 0, FLAG_CAP));
        } else if (t === s.ep && s.b[t] === 0) {
          out.push(packMove(sq, t, piece, P, 0, FLAG_EP));
        }
      }
    } else if (piece === N || piece === K) {
      const offs = piece === N ? KNIGHT_OFFS : KING_OFFS;
      for (const o of offs) {
        const t = sq + o;
        if (t < 0 || t > 63) continue;
        const df = (t & 7) - f;
        if (piece === N ? Math.abs(df) > 2 : (df < -1 || df > 1)) continue;
        const victim = s.b[t];
        if (victim !== 0 && Math.sign(victim) !== turn) out.push(packMove(sq, t, piece, Math.abs(victim), 0, FLAG_CAP));
      }
    } else {
      const dirs = piece === R ? ROOK_DIRS : piece === B ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
      for (const d of dirs) {
        let t = sq + d, steps = 1;
        while (t >= 0 && t < 64) {
          if (piece === R || piece === Q) {
            if (d === 1 || d === -1) { if ((t & 7) !== f + d * steps) break; }
            else if ((t >> 3) !== r + (d > 0 ? 1 : -1) * steps) break;
          } else {
            const df = (d === 7 || d === -9) ? -1 : 1;
            if ((t & 7) !== f + df * steps) break;
            if ((t >> 3) !== r + (d > 0 ? 1 : -1) * steps) break;
          }
          const victim = s.b[t];
          if (victim !== 0) {
            if (Math.sign(victim) !== turn) out.push(packMove(sq, t, piece, Math.abs(victim), 0, FLAG_CAP));
            break;
          }
          t = sq + d * (++steps);
        }
      }
    }
  }
  // legality filter (same as generateLegal)
  const res = [];
  for (const m of out) {
    const n = applyMove(s, m);
    if (!isAttacked(n.b, turn === WHITE ? n.wksq : n.bksq, -turn)) res.push(m);
  }
  return res;
}

// ---- position symmetry transforms (for the learner's 4x generalization) ----
// mirror (a<->h), color-invert (white<->black), and 180 rotation (both). All
// preserve legality AND the engine's evaluation, so an exception learned at a
// position is valid at its transforms too — a safe way to multiply the
// effective database size without storing more lessons.
export const TRANSFORM_IDENTITY = 0, TRANSFORM_MIRROR = 1, TRANSFORM_INVERT = 2, TRANSFORM_ROTATE = 3;
export const TRANSFORM_MODES = [TRANSFORM_IDENTITY, TRANSFORM_MIRROR, TRANSFORM_INVERT, TRANSFORM_ROTATE];

export function transformSquare(sq, mode) {
  if (mode === TRANSFORM_IDENTITY) return sq;
  if (mode === TRANSFORM_MIRROR) return (sq & ~7) | (7 - (sq & 7));
  return 63 - sq; // invert keeps squares; rotate flips both
}

export function transformPosition(state, mode) {
  if (mode === TRANSFORM_IDENTITY) return cloneState(state);
  ensureZ();
  const mirror = mode === TRANSFORM_MIRROR;
  const n = { ...state, b: new Int8Array(64), turn: mirror ? state.turn : -state.turn };
  for (let sq = 0; sq < 64; sq++) {
    // invert keeps squares (only colors swap); mirror and rotate move them
    const src = mode === TRANSFORM_MIRROR ? transformSquare(sq, TRANSFORM_MIRROR)
      : mode === TRANSFORM_INVERT ? sq
      : 63 - sq;
    n.b[sq] = mirror ? state.b[src] : -state.b[src];
  }
  // castling rights: WK=1 WQ=2 BK=4 BQ=8
  const r = state.rights;
  n.rights =
    mode === TRANSFORM_MIRROR ? ((r & 1) ? 2 : 0) | ((r & 2) ? 1 : 0) | ((r & 4) ? 8 : 0) | ((r & 8) ? 4 : 0)
    : mode === TRANSFORM_INVERT ? ((r & 1) ? 4 : 0) | ((r & 2) ? 8 : 0) | ((r & 4) ? 1 : 0) | ((r & 8) ? 2 : 0)
    : ((r & 1) ? 8 : 0) | ((r & 2) ? 4 : 0) | ((r & 4) ? 2 : 0) | ((r & 8) ? 1 : 0);
  n.ep = state.ep < 0 ? -1
    : mode === TRANSFORM_MIRROR ? transformSquare(state.ep, TRANSFORM_MIRROR)
    : mode === TRANSFORM_INVERT ? state.ep
    : 63 - state.ep;
  // kings + keys from scratch (consistent with applyMove's incremental path)
  n.wksq = n.bksq = -1;
  for (let sq = 0; sq < 64; sq++) {
    const pc = n.b[sq];
    if (pc === K) n.wksq = sq;
    else if (pc === -K) n.bksq = sq;
  }
  initKeys(n);
  return n;
}

export function transformMove(m, mode) {
  if (mode === TRANSFORM_IDENTITY) return m;
  return packMove(
    transformSquare(mvFrom(m), mode), transformSquare(mvTo(m), mode),
    mvPiece(m), mvCaptured(m), mvPromo(m), mvFlags(m)
  );
}

// ---------------------------------------------------------------- game result

export function insufficientMaterial(s) {
  let pieces = 0;
  let minors = []; // [piece, color, square]
  for (let sq = 0; sq < 64; sq++) {
    const pc = s.b[sq];
    if (pc === 0) continue;
    pieces++;
    const a = Math.abs(pc);
    if (a === P || a === R || a === Q) return false;
    if (a === N || a === B) minors.push([a, Math.sign(pc), sq]);
  }
  if (pieces <= 2) return true; // K vs K
  if (minors.length === 1) return true; // K+minor vs K
  if (minors.length === 2) {
    const [a1, c1, s1] = minors[0], [a2, c2, s2] = minors[1];
    if (a1 === B && a2 === B && c1 === c2 && ((s1 + s2) & 1) === 0) return true; // same-colored bishops
  }
  return false;
}

// Returns { status, winner } — winner is WHITE/BLACK/0 (draw). Status: ongoing,
// checkmate, stalemate, draw-50, draw-3fold, draw-material.
export function gameResult(s, historyKeys = []) {
  const legal = generateLegal(s);
  if (legal.length === 0) {
    if (inCheck(s)) return { status: 'checkmate', winner: -s.turn };
    return { status: 'stalemate', winner: 0 };
  }
  if (s.half >= 100) return { status: 'draw-50', winner: 0 };
  if (historyKeys.length) {
    let count = 0;
    for (const [k1, k2] of historyKeys) {
      if (k1 === s.k1 && k2 === s.k2 && ++count >= 2) return { status: 'draw-3fold', winner: 0 };
    }
  }
  if (insufficientMaterial(s)) return { status: 'draw-material', winner: 0 };
  return { status: 'ongoing', winner: 0 };
}

// ---------------------------------------------------------------- perft

export function perft(s, depth) {
  if (depth === 0) return 1;
  const moves = generateLegal(s);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(applyMove(s, m), depth - 1);
  return n;
}
