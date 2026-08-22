// learner.js — the per-difficulty exception learner.
//
// Idea (per spec): if a path the engine chose fails, compute a backtrace to the
// next board that does not always lead to an equivalent bad outcome, and store
// it as an exception FOR A GIVEN DIFFICULTY (search depth). On a later play, at
// a known exception board (same difficulty), the engine backtracks and tries
// something different.
//
// Two ways exceptions are created:
//   1. search-time self-correction — the search chose a move whose score is
//      badly losing while a clearly-better alternative existed (engine's own
//      knowledge at that depth).
//   2. game-loss backtrace — the engine lost; walk the decision log back from
//      the loss to the first decision where an alternative move's score was
//      not equivalently bad, and record it.
//
// Exceptions are keyed by (difficulty, position). A position is identified by
// the compact FEN position key (placement + side + castling + normalized ep).
// Records keep the 64-bit zobrist halves so search can match them in O(1).
//
// Storage: localStorage (JSON), namespaced per difficulty. Also exportable.

import { positionKey, fenToState, transformPosition, transformMove, TRANSFORM_MODES } from './board.js';

const STORAGE_KEY = 'cheap-chess.exceptions.v1';
const MAX_BAD_PER_POSITION = 5;
const MAX_TOTAL = 2000; // per-profile budget (records fan out 4x across symmetry
                       // transforms, so 2000 ≈ 500 real lessons + their mirrors)

// The storage key includes a NAMESPACE derived from the engine-profile
// fingerprint (config.js). Exceptions learned under one profile (piece values,
// center control, bonuses, mate score) are NEVER applied under another —
// changing any knob gives the engine a fresh, separate cache. Difficulty
// remains a per-record dimension inside the namespace.

export const BLUNDER_CP = -200;   // chosen move scored this badly → it "failed"
export const IMPROVEMENT_CP = 100; // alternative must be at least a pawn better

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, v); }
  removeItem(k) { this.map.delete(k); }
}

// Exported so a web worker can hold a throwaway learner without localStorage.
export { MemoryStorage };

export class CheapLearner {
  constructor({ storage, namespace } = {}) {
    this.enabled = true;
    this.namespace = namespace || 'default';
    this._key = STORAGE_KEY + '.' + this.namespace;
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
    // per difficulty: poskey -> record { bad: [moves], good: move, why, times, at }
    this.byDifficulty = new Map();
    // per difficulty: `${k1}:${k2}` -> poskey  (search-time O(1) match)
    this.keyIndex = new Map();
    this.load();
  }

  // ---------------------------------------------------------------- storage

  load() {
    this.byDifficulty = new Map();
    this.keyIndex = new Map();
    let raw = null;
    try { raw = this.storage.getItem(this._key); } catch { /* private mode etc. */ }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || data.v !== 1) return;
    for (const [diffStr, positions] of Object.entries(data.difficulties || {})) {
      const diff = +diffStr;
      const dm = new Map();
      for (const [poskey, rec] of Object.entries(positions)) {
        if (!rec || !rec.bad || !rec.good) continue;
        const r = { bad: new Set(rec.bad.map((m) => parseInt(m, 36))), good: parseInt(rec.good, 36), why: rec.why || 'unknown', times: rec.times || 1, at: rec.at || 0 };
        dm.set(poskey, r);
        this._indexKey(diff, poskey, r);
      }
      if (dm.size) this.byDifficulty.set(diff, dm);
    }
  }

  save() {
    const data = { v: 1, difficulties: {} };
    for (const [diff, dm] of this.byDifficulty) {
      const positions = {};
      for (const [poskey, r] of dm) {
        positions[poskey] = {
          bad: [...r.bad].map((m) => m.toString(36)),
          good: r.good.toString(36),
          why: r.why,
          times: r.times,
          at: r.at,
        };
      }
      data.difficulties[String(diff)] = positions;
    }
    try { this.storage.setItem(this._key, JSON.stringify(data)); } catch { /* ignore */ }
  }

  _indexKey(diff, poskey, record) {
    if (!record._k1) {
      const s = fenToState(poskey);
      record._k1 = s.k1; record._k2 = s.k2;
    }
    this.keyIndex.set(diff + ':' + record._k1 + ':' + record._k2, poskey);
  }

  // ---------------------------------------------------------------- lookup

  // Search-time O(1) lookup by zobrist halves. Returns { bad: Set, good } or null.
  lookup(difficulty, k1, k2) {
    const poskey = this.keyIndex.get(difficulty + ':' + k1 + ':' + k2);
    if (!poskey) return null;
    const dm = this.byDifficulty.get(difficulty);
    const rec = dm ? dm.get(poskey) : null;
    if (rec) rec.at = Date.now(); // usage-based eviction keeps hot lessons
    return rec;
  }

  count(difficulty) {
    const dm = this.byDifficulty.get(difficulty);
    return dm ? dm.size : 0;
  }

  total() {
    let n = 0;
    for (const dm of this.byDifficulty.values()) n += dm.size;
    return n;
  }

  list(difficulty) {
    const dm = this.byDifficulty.get(difficulty);
    if (!dm) return [];
    return [...dm.entries()].map(([poskey, r]) => ({ poskey, bad: [...r.bad], good: r.good, why: r.why, times: r.times, at: r.at }));
  }

  clear(difficulty) {
    if (difficulty === undefined) { this.byDifficulty = new Map(); this.keyIndex = new Map(); }
    else {
      const dm = this.byDifficulty.get(difficulty);
      if (dm) {
        for (const r of dm.values()) this.keyIndex.delete(difficulty + ':' + r._k1 + ':' + r._k2);
        this.byDifficulty.delete(difficulty);
      }
    }
    this.save();
  }

  // ---------------------------------------------------------------- record

  // Record "at this position, badMove failed; prefer goodMove" for a difficulty.
  // The lesson fans out across the 4 symmetry transforms (identity, mirror,
  // color-invert, rotate) — the engine's eval is symmetric, so a lesson valid
  // at one board is valid at its mirrors: a 4x effective database.
  record(difficulty, state, badMove, goodMove, why) {
    if (!badMove || !goodMove || badMove === goodMove) return false;
    let recorded = false;
    for (const mode of TRANSFORM_MODES) {
      const st = mode === 0 ? state : transformPosition(state, mode);
      const poskey = positionKey(st);
      const bm = mode === 0 ? badMove : transformMove(badMove, mode);
      const gm = mode === 0 ? goodMove : transformMove(goodMove, mode);
      if (this._recordAt(difficulty, poskey, st, bm, gm, why)) recorded = true;
    }
    if (recorded) this.save();
    return recorded;
  }

  _recordAt(difficulty, poskey, st, badMove, goodMove, why) {
    let dm = this.byDifficulty.get(difficulty);
    if (!dm) { dm = new Map(); this.byDifficulty.set(difficulty, dm); }
    let rec = dm.get(poskey);
    if (!rec) {
      if (this.total() >= MAX_TOTAL) this._evictOne();
      rec = { bad: new Set(), good: 0, why, times: 0, at: 0, _k1: st.k1, _k2: st.k2 };
      dm.set(poskey, rec);
      this.keyIndex.set(difficulty + ':' + st.k1 + ':' + st.k2, poskey);
    }
    if (rec.bad.has(badMove)) rec.bad.delete(badMove);
    rec.bad.add(badMove);
    if (rec.bad.size > MAX_BAD_PER_POSITION) {
      const first = rec.bad.values().next().value;
      rec.bad.delete(first);
    }
    rec.good = goodMove;
    rec.why = why;
    rec.times++;
    rec.at = Date.now();
    return true;
  }

  _evictOne() {
    // evict the least-recently-touched record
    let worst = null, worstAt = Infinity, worstDiff = null, worstKey = null;
    for (const [diff, dm] of this.byDifficulty) {
      for (const [poskey, r] of dm) {
        if (r.at < worstAt) { worstAt = r.at; worst = r; worstDiff = diff; worstKey = poskey; }
      }
    }
    if (worst) {
      this.keyIndex.delete(worstDiff + ':' + worst._k1 + ':' + worst._k2);
      this.byDifficulty.get(worstDiff).delete(worstKey);
      if (this.byDifficulty.get(worstDiff).size === 0) this.byDifficulty.delete(worstDiff);
    }
  }

  // ---------------------------------------------------------------- learning

  export() {
    return this.storage.getItem(this._key);
  }

  // Compact transport for the search worker: rows are [k1, k2, bad[], good].
  exportCompact(difficulty) {
    const dm = this.byDifficulty.get(difficulty);
    if (!dm) return [];
    return [...dm.values()].map((r) => [r._k1, r._k2, [...r.bad], r.good]);
  }

  importCompact(difficulty, rows) {
    for (const [k1, k2, bad, good] of rows) {
      let dm = this.byDifficulty.get(difficulty);
      if (!dm) { dm = new Map(); this.byDifficulty.set(difficulty, dm); }
      const poskey = k1 + ':' + k2; // not the real poskey, but only used for in-memory lookup
      const rec = { bad: new Set(bad), good, why: 'worker', times: 1, at: Date.now(), _k1: k1, _k2: k2 };
      dm.set(poskey, rec);
      this.keyIndex.set(difficulty + ':' + k1 + ':' + k2, poskey);
    }
  }

  import(json) {
    try {
      const data = JSON.parse(json);
      if (!data || data.v !== 1) return false;
      this.storage.setItem(this._key, json);
      this.load();
      return true;
    } catch { return false; }
  }
}
