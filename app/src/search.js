// search.js — Cheap Chess search: a fixed-size reusable node pool + iterative
// deepening negamax (alpha-beta, fail-soft).
//
// Architecture (per spec):
//   * The move tree lives in a FIXED-SIZE pool of nodes (parallel typed arrays
//     + a free list). No unbounded allocation, no GC churn. If the pool is
//     exhausted mid-search the search degrades gracefully (best-so-far) and
//     reports poolExhausted.
//   * Each engine turn searches to the difficulty cap via iterative deepening.
//   * After a move is played, advance() retargets the root to the played line
//     and FREES the memory for branches that weren't played — so the pool is
//     reused turn after turn and the tree from the original root grows one
//     level deeper per turn ("searches one more level").
//   * The learner's exceptions are applied at any node whose position matches a
//     known exception board (for the current difficulty): the bad move is
//     excluded, so the search backtracks and tries something different.
//
// Deterministic: same position + same difficulty + same exceptions =>
// same best move (stable ordering, fixed seed). The learner relies on this.

import {
  WHITE, BLACK, P, N, B, R, Q, K,
  generateLegal, generateCaptures, applyMove, inCheck, uciName,
} from './board.js';
import { evaluate } from './eval.js';
import { DEFAULT_CONFIG } from './config.js';

export const MATE = DEFAULT_CONFIG.mateScore; // default "winning the game" value
export const DEFAULT_POOL_SIZE = 524288; // ~14 MB; see poolSizeForDepth for scaling
export const MAX_PLY = 64;

// RAM budget for the whole search (all workers combined). ~22 bytes per node,
// so 40M nodes ≈ 880 MB — a sane ceiling for a browser tab, far below the
// system's 124 GB (the Node/UCI path can raise it via PoolSize).
export const SEARCH_RAM_BUDGET_NODES = 40_000_000;

// Tiered pool sizing so higher difficulties stay honest (the fixed-pool brief
// still holds: memory is bounded per difficulty, just not constant). Tiers are
// divided by the worker count when searching in parallel.
const POOL_TIERS = [
  65536, 65536, 131072, 262144, 524288, 1048576, 2097152, // d1..d7
  4194304, 8388608, 16777216, 30000000, 40000000, 40000000, 40000000, // d8..d14
];
export function poolSizeForDepth(d, workers = 1) {
  const tier = POOL_TIERS[Math.max(1, Math.min(14, d)) - 1] || POOL_TIERS[13];
  return Math.max(65536, Math.min(tier, Math.floor(SEARCH_RAM_BUDGET_NODES / Math.max(1, workers))));
}

// Bounded transposition table: capped at 1M entries (~18 MB) regardless of
// pool size, so deep searches don't multiply memory.
const TT_MAX_ENTRIES = 1 << 20;

const INF = 1 << 30;

// ---- bounded transposition table ------------------------------------------
// Fixed-size (entries scale with the pool), deterministic overwrite policy.
// The single biggest search-efficiency win: reuses previous searches' scores
// and best moves for move ordering, so the difficulty knob is honest.
const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

class TranspositionTable {
  constructor(entries) {
    this.n = Math.max(1 << 14, 1 << Math.ceil(Math.log2(entries)));
    this.mask = this.n - 1;
    this.k1 = new Int32Array(this.n);
    this.k2 = new Int32Array(this.n);
    this.depth = new Uint8Array(this.n);
    this.flag = new Uint8Array(this.n);
    this.score = new Int32Array(this.n);
    this.move = new Int32Array(this.n);
  }
  clear() { this.k1.fill(0); this.k2.fill(0); this.depth.fill(0); }
  probe(k1, k2, depth) {
    const i = (Math.imul(k1, 0x9e3779b1) ^ k2) & this.mask;
    if (this.k1[i] === k1 && this.k2[i] === k2 && this.depth[i] >= depth) {
      return { score: this.score[i], flag: this.flag[i], move: this.move[i] };
    }
    return null;
  }
  store(k1, k2, depth, flag, score, move) {
    const i = (Math.imul(k1, 0x9e3779b1) ^ k2) & this.mask;
    this.k1[i] = k1; this.k2[i] = k2;
    this.depth[i] = Math.min(255, depth);
    this.flag[i] = flag;
    this.score[i] = score;
    this.move[i] = move;
  }
}

export class MovePool {
  // cap is the MAX capacity; the arena grows lazily from a small start so huge
  // difficulties don't allocate gigabytes up front.
  constructor(cap = DEFAULT_POOL_SIZE) {
    this.maxCap = cap;
    this.cap = Math.min(cap, 262144);
    this.move = new Int32Array(this.cap);
    this.firstChild = new Int32Array(this.cap).fill(-1);
    this.nextSibling = new Int32Array(this.cap).fill(-1);
    this.bestChild = new Int32Array(this.cap).fill(-1);
    this.depth = new Int16Array(this.cap);
    this.score = new Int32Array(this.cap);
    this._free = [];       // free indices
    this._next = 0;        // low-water mark of used indices
    this.root = -1;
  }

  get used() { return this._next - this._free.length; }
  get util() { return this.used / this.maxCap; }

  grow() {
    if (this.cap >= this.maxCap) return false;
    const newCap = Math.min(this.maxCap, this.cap * 2);
    for (const name of ['move', 'firstChild', 'nextSibling', 'bestChild', 'score']) {
      const na = new Int32Array(newCap);
      na.set(this[name]);
      if (name.endsWith('Child')) na.fill(-1, this.cap);
      this[name] = na;
    }
    const nd = new Int16Array(newCap); nd.set(this.depth); this.depth = nd;
    this.cap = newCap;
    return true;
  }

  alloc() {
    if (this._free.length > 0) return this._free.pop();
    if (this._next >= this.cap && !this.grow()) return -1; // pool exhausted
    const i = this._next++;
    this.firstChild[i] = -1;
    this.nextSibling[i] = -1;
    this.bestChild[i] = -1;
    this.move[i] = 0;
    return i;
  }

  free(i) { if (i >= 0) this._free.push(i); }

  // Free a node and all of its descendants.
  freeSubtree(root) {
    if (root < 0) return;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      let c = this.firstChild[n];
      while (c >= 0) { stack.push(c); c = this.nextSibling[c]; }
      this.firstChild[n] = -1;
      this.nextSibling[n] = -1;
      this.bestChild[n] = -1;
      this.move[n] = 0;
      this.free(n);
    }
  }

  freeTree() {
    if (this.root >= 0) {
      const r = this.root;
      let c = this.firstChild[r];
      while (c >= 0) { const nx = this.nextSibling[c]; this.freeSubtree(c); c = nx; }
      this.firstChild[r] = -1;
      this.nextSibling[r] = -1;
      this.bestChild[r] = -1;
      this.free(r);
      this.root = -1;
    }
  }

  // Retarget the root to the kept line (the move that was actually played) and
  // free everything else. Returns true if the line was found in the pool.
  advance(move) {
    const r = this.root;
    if (r < 0) return false;
    let match = -1;
    let c = this.firstChild[r];
    while (c >= 0) {
      const nx = this.nextSibling[c];
      if (match < 0 && this.move[c] === move) match = c;
      else this.freeSubtree(c);
      c = nx;
    }
    if (match < 0) { this.free(r); this.root = -1; return false; }
    this.firstChild[r] = -1; this.nextSibling[r] = -1; this.bestChild[r] = -1;
    this.free(r);
    this.root = match;
    return true;
  }

  // Debug integrity check: every allocated node must be reachable from the
  // root exactly once, and everything else must be in the free list.
  debugCheck() {
    const seen = new Set();
    const stack = this.root >= 0 ? [this.root] : [];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) return `node ${n} reachable twice`;
      seen.add(n);
      let c = this.firstChild[n];
      while (c >= 0) { stack.push(c); c = this.nextSibling[c]; }
    }
    const freeSet = new Set(this._free);
    for (const i of seen) if (freeSet.has(i)) return `node ${i} both used and free`;
    for (let i = 0; i < this._next; i++) if (!seen.has(i) && !freeSet.has(i)) return `node ${i} leaked`;
    return null;
  }
}

export class Searcher {
  constructor({ poolSize = DEFAULT_POOL_SIZE, config, tradeBonus } = {}) {
    this.pool = new MovePool(poolSize);
    // engine profile (see config.js); the optional tradeBonus keeps the old API
    this.config = config ? { ...DEFAULT_CONFIG, ...config } : { ...DEFAULT_CONFIG };
    if (tradeBonus !== undefined) this.config.tradeBonus = tradeBonus;
    this.history = new Int32Array(4096);
    this.killers = new Int32Array(2 * MAX_PLY).fill(0);
    this.tt = new TranspositionTable(Math.max(1 << 14, Math.min(TT_MAX_ENTRIES, Math.max(poolSize >> 1, 1 << 16))));
    this.stopRequested = false;
    this.interrupted = false;
    this.nodes = 0;
    this.histCounts = new Map();
  }

  newGame() {
    this.pool.freeTree();
    this.history.fill(0);
    this.killers.fill(0);
    this.tt.clear();
    this.stopRequested = false;
  }

  // Forget ordering/search knowledge (called when the learner records, so
  // exceptions stay authoritative).
  clearSearchState() {
    this.history.fill(0);
    this.killers.fill(0);
    this.tt.clear();
  }

  stop() { this.stopRequested = true; }

  // --- move ordering -----------------------------------------------------

  _orderScore(m, ply) {
    const flags = (m >> 21) & 7;
    const cap = (m >> 15) & 7;
    if (flags === 2 || flags === 4) return 800 + 8 * (cap + 1) - ((m >> 18) & 7); // MVV-LVA
    if (flags === 6) return 700 + ((m >> 12) & 7);
    const from = m & 63, to = (m >> 6) & 63;
    if (this.killers[2 * ply] === m || this.killers[2 * ply + 1] === m) return 600;
    return this.history[from * 64 + to];
  }

  _orderMoves(moves, ply) {
    const sc = (m) => this._orderScore(m, ply);
    moves.sort((a, b) => sc(b) - sc(a)); // stable sort keeps generation order on ties
  }

  // --- search ------------------------------------------------------------

  // opts: { timeLimitMs, learner, difficulty, historyKeys (array of [k1,k2]) }
  search(state, depthLimit, opts = {}) {
    const pool = this.pool;
    this.stopRequested = false;
    this.interrupted = false;
    this.nodes = 0;
    this.poolExhausted = false;
    const started = Date.now();
    const timeLimit = opts.timeLimitMs || 0;

    // repetition counts from the game history (root position included)
    this.histCounts = new Map();
    for (const [k1, k2] of (opts.historyKeys || [])) {
      const key = k1 + ':' + k2;
      this.histCounts.set(key, (this.histCounts.get(key) || 0) + 1);
    }

    let root = pool.root;
    if (root < 0) root = pool.alloc();
    if (root < 0) return { move: 0, score: 0, pv: [], rootScores: [], stats: { depth: 0, nodes: 0, ms: 0, poolExhausted: true, interrupted: false } };
    pool.root = root;
    pool.move[root] = 0;
    pool.depth[root] = 0;

    let bestMove = 0, bestScore = -INF, bestDepth = 0;
    const pathKeys = [];
    // The last FULLY-COMPLETED iteration. If the search is interrupted by the
    // timer (competition mode) or pool exhaustion, we go with whatever the last
    // completed depth produced — never a partial iteration.
    let lastComplete = null;

    for (let d = 1; d <= depthLimit; d++) {
      if (timeLimit && Date.now() - started > timeLimit) break;
      // Fresh iteration: free everything below the root.
      let c = pool.firstChild[root];
      while (c >= 0) { const nx = pool.nextSibling[c]; pool.freeSubtree(c); c = nx; }
      pool.firstChild[root] = -1;
      pool.bestChild[root] = -1;
      this.killers.fill(0);

      const score = this._negamax(root, state, d, -INF, INF, 0, opts, pathKeys, started, timeLimit);
      if (this.interrupted) break;

      // trading personality: nudge capture moves at the root (safe trades only —
      // material loss already dominates, so this is just the tie-breaker)
      // trading personality: nudge capture moves at the root (safe trades only —
      // material loss already dominates, so this is just the tie-breaker)
      const tradeBonus = this.config.tradeBonus;
      if (tradeBonus) {
        let ch = pool.firstChild[root];
        while (ch >= 0) {
          const flags = (pool.move[ch] >> 21) & 7;
          if (flags === 2 || flags === 4) pool.score[ch] += tradeBonus; // capture / en-passant
          ch = pool.nextSibling[ch];
        }
      }

      // snapshot the completed iteration (scores now include the trade bonus)
      bestDepth = d;
      let bestChild = pool.bestChild[root];
      if (bestChild >= 0) {
        // best move after the bonus may differ from the raw search best
        let best = -INF;
        let ch2 = pool.firstChild[root];
        while (ch2 >= 0) {
          if (pool.score[ch2] > best) { best = pool.score[ch2]; bestChild = ch2; }
          ch2 = pool.nextSibling[ch2];
        }
        bestMove = pool.move[bestChild];
        bestScore = best;
      } else bestScore = score;
      const rootScores = [];
      let ch3 = pool.firstChild[root];
      while (ch3 >= 0) { rootScores.push([pool.move[ch3], pool.score[ch3]]); ch3 = pool.nextSibling[ch3]; }
      rootScores.sort((a, b) => b[1] - a[1]);
      const pv = [];
      let n = bestChild;
      while (n >= 0) { pv.push(pool.move[n]); n = pool.bestChild[n]; }
      lastComplete = { move: bestMove, score: bestScore, depth: bestDepth, pv, rootScores };

      if (opts.onIteration) {
        opts.onIteration({
          depth: d, score: bestScore, move: bestMove, nodes: this.nodes, ms: Date.now() - started,
          poolExhausted: this.poolExhausted || pool.used >= pool.cap,
        });
      }
    }

    if (!lastComplete) {
      // interrupted before the first depth finished (immediate stop)
      return {
        move: 0, score: 0, pv: [], rootScores: [],
        stats: { depth: 0, nodes: this.nodes, ms: Date.now() - started, poolUsed: pool.used,
                 poolExhausted: this.poolExhausted || pool.used >= pool.cap, interrupted: this.interrupted, poolUtil: 0 },
      };
    }

    return {
      move: lastComplete.move,
      score: lastComplete.score,
      pv: lastComplete.pv,
      rootScores: lastComplete.rootScores,
      stats: {
        depth: lastComplete.depth,
        nodes: this.nodes,
        ms: Date.now() - started,
        poolUsed: pool.used,
        poolExhausted: this.poolExhausted || pool.used >= pool.cap,
        interrupted: this.interrupted,
        poolUtil: +(pool.util * 100).toFixed(1),
      },
    };
  }

  // Deterministic per-worker eval jitter (Lazy SMP diversity): a tiny ±30pt
  // offset seeded by (worker index, position) so parallel workers explore
  // different lines. Seed 0 = no noise => identical to the single-threaded
  // search, so tests and competition mode stay deterministic.
  _noise(state) {
    const seed = this.config.evalNoiseSeed;
    if (!seed) return 0;
    const h = (Math.imul(seed, 0x9e3779b1) ^ state.k1) >>> 0;
    return (h % 61) - 30;
  }

  // Search only a caller-supplied slice of ROOT moves at one depth with a
  // shared root alpha (parallel root-move splitting — the orchestrator in
  // parallel-search.js distributes the root moves and syncs alpha per round).
  // Each move is searched with window (-INF, -alpha) via the normal negamax.
  searchRootMoves(state, slice, depth, alpha, opts = {}) {
    const pool = this.pool;
    this.stopRequested = false;
    this.interrupted = false;
    this.nodes = 0;
    this.poolExhausted = false;
    const started = Date.now();
    const timeLimit = opts.timeLimitMs || 0;

    this.histCounts = new Map();
    for (const [k1, k2] of (opts.historyKeys || [])) {
      const key = k1 + ':' + k2;
      this.histCounts.set(key, (this.histCounts.get(key) || 0) + 1);
    }

    const root = pool.alloc();
    if (root < 0) {
      return { move: 0, score: 0, pv: [], rootScores: [], stats: { depth: 0, nodes: 0, ms: 0, poolExhausted: true, interrupted: false } };
    }
    pool.root = root;
    pool.move[root] = 0;
    pool.firstChild[root] = -1;
    pool.nextSibling[root] = -1;
    pool.bestChild[root] = -1;

    const pathKeys = [];
    let best = -INF, bestChild = -1, lastChild = -1;
    const scores = [];
    for (const m of slice) {
      if (this.interrupted) break;
      const child = pool.alloc();
      if (child < 0) { this.poolExhausted = true; this.interrupted = true; break; }
      pool.move[child] = m;
      pool.firstChild[child] = -1;
      pool.nextSibling[child] = -1;
      pool.bestChild[child] = -1;
      if (lastChild < 0) pool.firstChild[root] = child;
      else pool.nextSibling[lastChild] = child;
      lastChild = child;

      const childState = applyMove(state, m);
      pathKeys.push(state.k1, state.k2);
      const childScore = this._negamax(child, childState, depth - 1, -INF, -alpha, 1, opts, pathKeys, started, timeLimit);
      pathKeys.pop();
      pathKeys.pop();
      const score = -childScore;
      pool.score[child] = score;
      scores.push([m, score]);
      if (score > best) { best = score; bestChild = child; }
    }

    const pv = [];
    let n = bestChild;
    while (n >= 0) { pv.push(pool.move[n]); n = pool.bestChild[n]; }

    return {
      move: bestChild >= 0 ? pool.move[bestChild] : 0,
      score: best,
      pv,
      rootScores: scores,
      stats: {
        depth,
        nodes: this.nodes,
        ms: Date.now() - started,
        poolUsed: pool.used,
        poolExhausted: this.poolExhausted || pool.used >= pool.maxCap,
        interrupted: this.interrupted,
      },
    };
  }

  // Quiescence search: at the depth limit, keep searching captures (and, when
  // in check, every evasion) until the position is quiet, then stand pat.
  // Stand-pat: if doing nothing already beats beta, stop. Repetition/50-move
  // draws apply here too (perpetual checks resolve to a draw, not a line).
  // Allocates no pool nodes — the fixed-size arena is untouched.
  _quiescence(state, alpha, beta, ply, qd, opts, pathKeys, started, timeLimit) {
    this.nodes++;
    if (this.stopRequested || ((this.nodes & 4095) === 0 && timeLimit && Date.now() - started > timeLimit)) {
      this.interrupted = true;
      return (alpha + beta) / 2;
    }
    if (ply > 0) {
      if (state.half >= 100) return 0;
      let repeats = this.histCounts.get(state.k1 + ':' + state.k2) || 0;
      if (repeats < 2) {
        for (let i = pathKeys.length - 2; i >= 0; i -= 2) {
          if (pathKeys[i] === state.k1 && pathKeys[i + 1] === state.k2 && ++repeats >= 2) break;
        }
      }
      if (repeats >= 2) return 0; // third occurrence => draw
    }

    const inChk = inCheck(state);
    const standPat = evaluate(state, this.config) + this._noise(state);
    if (!inChk) {
      if (standPat >= beta) return standPat; // stand-pat cutoff
      if (qd <= 0) return standPat;
    }

    const moves = inChk ? generateLegal(state) : generateCaptures(state);
    if (moves.length === 0) {
      return inChk ? -(this.config.mateScore - ply) : standPat;
    }
    this._orderMoves(moves, ply);

    let best = inChk ? -INF : standPat;
    for (const m of moves) {
      // crude SEE: skip capture chains that hand over more than they take
      // (attacker worth more than victim) — stops queen-chases-pawn blowups
      if (!inChk) {
        const attacker = this.config.pieceValues[(m >> 18) & 7];
        const victim = this.config.pieceValues[(m >> 15) & 7];
        if (attacker > victim) continue;
      }
      const childState = applyMove(state, m);
      pathKeys.push(state.k1, state.k2);
      const score = -this._quiescence(childState, -beta, -alpha, ply + 1, qd - 1, opts, pathKeys, started, timeLimit);
      pathKeys.pop();
      pathKeys.pop();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
      if (this.interrupted) break;
    }
    return best;
  }

  _negamax(nodeIdx, state, depth, alpha, beta, ply, opts, pathKeys, started, timeLimit) {
    this.nodes++;
    if (this.stopRequested) { this.interrupted = true; return alpha; }
    if ((this.nodes & 4095) === 0 && timeLimit && Date.now() - started > timeLimit) {
      this.stopRequested = true;
      this.interrupted = true;
      return alpha;
    }
    if (depth === 0) {
      // the "last minute check": resolve remaining captures (or a check)
      // before scoring, so the engine never evaluates a board mid-tactic
      if (this.config.quiescence && this.config.quiescenceDepth > 0) {
        return this._quiescence(state, alpha, beta, ply, this.config.quiescenceDepth, opts, pathKeys, started, timeLimit);
      }
      return evaluate(state, this.config) + this._noise(state);
    }

    // draw by repetition / 50-move (helps "doesn't lose": take the draw when losing)
    if (ply > 0) {
      if (state.half >= 100) return 0;
      let repeats = 0;
      const hk = this.histCounts.get(state.k1 + ':' + state.k2) || 0;
      repeats += hk;
      if (repeats < 2) {
        for (let i = pathKeys.length - 2; i >= 0; i -= 2) {
          if (pathKeys[i] === state.k1 && pathKeys[i + 1] === state.k2 && ++repeats >= 2) break;
        }
      }
      if (repeats >= 2) return 0; // third occurrence => draw
    }

    // learner: exclude known-bad moves at matching exception boards
    let excluded = null;
    if (opts.learner) {
      excluded = opts.learner.lookup(opts.difficulty, state.k1, state.k2);
    }

    // transposition table: reuse previous scores (not at the root — the root
    // needs exact child scores for the learner) and get the previous best move
    // for ordering
    const ttEntry = ply > 0 ? this.tt.probe(state.k1, state.k2, depth) : null;
    if (ttEntry) {
      if (ttEntry.flag === TT_EXACT) return ttEntry.score;
      if (ttEntry.flag === TT_LOWER && ttEntry.score >= beta) return ttEntry.score;
      if (ttEntry.flag === TT_UPPER && ttEntry.score <= alpha) return ttEntry.score;
    }

    const moves = (ply === 0 && opts.rootMoves) ? [...opts.rootMoves] : generateLegal(state);
    if (moves.length === 0) {
      return inCheck(state) ? -(this.config.mateScore - ply) : 0;
    }

    if (excluded) {
      // drop known-bad moves for this position
      for (let i = moves.length - 1; i >= 0; i--) {
        if (excluded.bad.has(moves[i])) { moves[i] = moves[moves.length - 1]; moves.pop(); }
      }
      if (moves.length === 0) {
        // defensive: every move was excluded — fall back to evaluation
        return evaluate(state, this.config);
      }
    }

    // TT best move first (still legal — excluded moves were removed above)
    if (ttEntry) {
      const ttIdx = moves.indexOf(ttEntry.move);
      if (ttIdx > 0) { moves[ttIdx] = moves[0]; moves[0] = ttEntry.move; }
    }
    // slices are pre-ordered by the orchestrator; the sequential search orders
    if (!opts.rootMoves) this._orderMoves(moves, ply);
    const pool = this.pool;
    let best = -INF; // true fail-soft: report real scores even below alpha, so
                     // slice searches under a shared root alpha stay accurate
    let lastChild = -1;

    for (const m of moves) {
      const child = pool.alloc();
      if (child < 0) { this.poolExhausted = true; this.interrupted = true; return best; } // pool exhausted
      pool.move[child] = m;
      pool.firstChild[child] = -1;
      pool.nextSibling[child] = -1;
      pool.bestChild[child] = -1;
      pool.depth[child] = ply + 1;
      if (lastChild < 0) pool.firstChild[nodeIdx] = child;
      else pool.nextSibling[lastChild] = child;
      lastChild = child;

      const childState = applyMove(state, m);
      pathKeys.push(state.k1, state.k2); // position BEFORE the move
      const childScore = this._negamax(child, childState, depth - 1, -beta, -alpha, ply + 1, opts, pathKeys, started, timeLimit);
      pathKeys.pop();
      pathKeys.pop();
      const score = -childScore;
      pool.score[child] = score;

      if (score > best) {
        best = score;
        pool.bestChild[nodeIdx] = child;
        if (score >= beta) {
          // beta cutoff — update killer & history for better ordering
          const flags = (m >> 21) & 7;
          if (flags !== 2 && flags !== 4 && flags !== 6) {
            const from = m & 63, to = (m >> 6) & 63;
            this.killers[2 * ply + 1] = this.killers[2 * ply];
            this.killers[2 * ply] = m;
            this.history[from * 64 + to] += depth * depth;
          }
          this.tt.store(state.k1, state.k2, depth, TT_LOWER, score, m);
          return score;
        }
      }
    }
    let flag = TT_EXACT;
    if (best <= alpha) flag = TT_UPPER;
    else if (best >= beta) flag = TT_LOWER;
    this.tt.store(state.k1, state.k2, depth, flag, best, pool.bestChild[nodeIdx] >= 0 ? pool.move[pool.bestChild[nodeIdx]] : 0);
    return best;
  }
}

// Convenience: one-shot search on a fresh searcher.
export function searchBest(state, depth, opts = {}) {
  const searcher = opts.searcher || new Searcher({ poolSize: opts.poolSize });
  return searcher.search(state, depth, opts);
}
