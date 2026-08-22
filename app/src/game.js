// game.js — Cheap Chess game controller.
// Owns the current position, the engine search (with learner hooks), the
// decision log used for loss backtraces, undo, and result detection.
// DOM-free: runs in the browser, a worker, or Node.

import { WHITE, BLACK, startState, fenToState, stateToFen, positionKey, applyMove, generateLegal, gameResult, uciName } from './board.js';import { Searcher, poolSizeForDepth } from './search.js';
import { CheapLearner, BLUNDER_CP, IMPROVEMENT_CP } from './learner.js';
import { san } from './san.js';
import { evaluate } from './eval.js';
import { DEFAULT_CONFIG, configFingerprint } from './config.js';

export class CheapGame {
  constructor({ difficulty = 4, learner = null, searcher = null, timeLimitMs = 0, config, poolSize } = {}) {
    this.difficulty = difficulty;
    this.config = config ? { ...DEFAULT_CONFIG, ...config } : { ...DEFAULT_CONFIG };
    // the learner cache is scoped to the engine profile (config fingerprint):
    // exceptions learned under other settings are never applied
    this.learner = learner || new CheapLearner({ namespace: configFingerprint(this.config) });
    this.searcher = searcher || new Searcher({ config: this.config, poolSize: poolSize || poolSizeForDepth(difficulty) });
    this.timeLimitMs = timeLimitMs;
    this.humanColor = WHITE;
    this._stack = [];
    this.reset();
  }

  // Change difficulty mid-game, growing the pool if needed.
  setSearchDepth(d, poolSize) {
    this.difficulty = d;
    const need = poolSize || poolSizeForDepth(d);
    if (this.searcher.pool.cap < need) {
      this.searcher = new Searcher({ config: this.config, poolSize: need });
    }
  }

  reset() {
    this.state = startState();
    this.searcher.newGame();
    this.historyKeys = [[this.state.k1, this.state.k2]];
    this.log = [];         // engine decision log (for the learner)
    this.moveList = [];    // SAN display history
    this.uciList = [];     // UCI move history (for persistence/replay)
    this.lastMove = 0;     // last packed move played
    this.result = { status: 'ongoing', winner: 0 };
    this.stats = null;
    this.lastEngine = null; // engine info from its most recent move
    this.learned = null;    // { poskey, badMove, goodMove, why } — learner event to surface in UI
    this._stack = [];
  }

  loadFen(fen) {
    this.state = fenToState(fen);
    this.searcher.newGame();
    this.historyKeys = [[this.state.k1, this.state.k2]];
    this.log = [];
    this.moveList = [];
    this.uciList = [];
    this.lastMove = 0;
    this.result = gameResult(this.state, this.historyKeys.slice(0, -1));
    this.stats = null;
    this.lastEngine = null;
    this.learned = null;
    this._stack = [];
  }

  isHumanTurn() { return this.result.status === 'ongoing' && this.state.turn === this.humanColor; }
  isOver() { return this.result.status !== 'ongoing'; }
  legalMoves() { return generateLegal(this.state); }
  fen() { return stateToFen(this.state); }

  // Apply a move by its UCI name (used by the UCI adapter and tests).
  applyUciMove(name) {
    if (this.isOver()) return { ok: false, reason: 'over' };
    const match = generateLegal(this.state).find((m) => uciName(m) === name);
    if (!match) return { ok: false, reason: 'illegal' };
    this._push(match);
    this.searcher.pool.advance(match);
    return { ok: true };
  }

  // ---- human move ---------------------------------------------------------

  playHuman(from, to, promo = 0) {
    if (!this.isHumanTurn()) return { ok: false, reason: 'not-your-turn' };
    const moves = generateLegal(this.state);
    const match = moves.find((m) => {
      if ((m & 63) !== from || ((m >> 6) & 63) !== to) return false;
      if (promo) return ((m >> 12) & 7) === promo;
      return ((m >> 12) & 7) === 0;
    });
    if (!match) return { ok: false, reason: 'illegal' };

    // checkpoint BEFORE the human move so undo() returns to the engine's turn
    this.checkpoint();

    // reply-refutation learning: the human's reply may reveal the engine's
    // previous choice was bad. The search-time scores can't show this (the
    // chosen move was the max of its own rootScores), so re-analyze the
    // previous decision with deeper vision when the reply position is bad.
    if (this.learner.enabled && this.log.length) {
      const prev = this.log[this.log.length - 1];
      const after = applyMove(this.state, match);
      if (evaluate(after) <= BLUNDER_CP) {
        this.learned = this._hindsight(prev);
        if (this.learned) this.searcher.clearSearchState();
      }
    }

    this._push(match);
    // advance the search pool along the played line (keeps the subtree, frees the rest)
    this.searcher.pool.advance(match);
    return { ok: true, result: this.result, san: this.moveList[this.moveList.length - 1] };
  }

  // ---- engine move --------------------------------------------------------

  // Synchronous engine move (uses this.searcher). Returns the engine result.
  engineMove() {
    if (this.isOver() || this.state.turn === this.humanColor) return null;
    const t0 = Date.now();
    const res = this.searcher.search(this.state, this.difficulty, {
      learner: this.learner.enabled ? this.learner : null,
      difficulty: this.difficulty,
      historyKeys: this.historyKeys,
      timeLimitMs: this.timeLimitMs,
    });
    res.thinkMs = Date.now() - t0;
    return this._finishEngineMove(res);
  }

  // Async engine move with a caller-supplied search provider (used by the UI's
  // web worker; the provider receives (state, difficulty, opts) and may return
  // a promise). The result shape must match searcher.search's.
  async engineMoveAsync(searchProvider) {
    if (this.isOver() || this.state.turn === this.humanColor) return null;
    const t0 = Date.now();
    const res = await searchProvider(this.state, this.difficulty, {
      learner: this.learner.enabled ? this.learner : null,
      difficulty: this.difficulty,
      historyKeys: this.historyKeys,
      timeLimitMs: this.timeLimitMs,
    });
    if (!res) return null;
    res.thinkMs = Date.now() - t0;
    return this._finishEngineMove(res);
  }

  _finishEngineMove(res) {
    if (res.move === 0) return res;

    // was a known exception board hit? (search already excludes the bad move,
    // so the engine performed its backtrack — surface it for the UI)
    if (this.learner.enabled) {
      const ex = this.learner.lookup(this.difficulty, this.state.k1, this.state.k2);
      if (ex) {
        this.learned = {
          poskey: positionKey(this.state),
          badMove: [...ex.bad].map((m) => uciName(m)),
          goodMove: uciName(ex.good),
          why: ex.why,
        };
      }
    }

    // log the decision (used for loss backtraces and reply-refutation)
    this.log.push({
      fen: stateToFen(this.state),
      poskey: positionKey(this.state),
      difficulty: this.difficulty,
      chosen: res.move,
      score: res.score,
      rootScores: res.rootScores.map(([m, s]) => [m, s]),
      histLen: this.historyKeys.length - 1, // history up to this position (excl. itself)
    });

    this._push(res.move);
    this.lastEngine = res;
    this.stats = res.stats;
    return res;
  }

  _push(move) {
    this.moveList.push(san(this.state, move));
    this.uciList.push(uciName(move));
    this.lastMove = move;
    this.state = applyMove(this.state, move);
    this.historyKeys.push([this.state.k1, this.state.k2]);
    this.result = gameResult(this.state, this.historyKeys.slice(0, -1));
  }

  // ---- undo / resign / learning ------------------------------------------

  checkpoint() {
    this._stack.push({
      state: this.state,
      historyKeys: this.historyKeys,
      moveList: this.moveList,
      uciList: this.uciList,
      lastMove: this.lastMove,
      log: this.log,
      lastEngine: this.lastEngine,
      stats: this.stats,
      learned: this.learned,
    });
    // shallow copies so earlier checkpoints stay intact
    this.state = { ...this.state, b: new Int8Array(this.state.b) };
    this.historyKeys = [...this.historyKeys];
    this.moveList = [...this.moveList];
    this.uciList = [...this.uciList];
    this.log = this.log.map((e) => ({ ...e, rootScores: e.rootScores.map(([m, s]) => [m, s]) }));
    if (this._stack.length > 500) this._stack.shift();
  }

  undo() {
    const snap = this._stack.pop();
    if (!snap) return false;
    this.state = snap.state;
    this.historyKeys = snap.historyKeys;
    this.moveList = snap.moveList;
    this.uciList = snap.uciList;
    this.lastMove = snap.lastMove;
    this.log = snap.log;
    this.lastEngine = snap.lastEngine;
    this.stats = snap.stats;
    this.learned = snap.learned;
    this.result = gameResult(this.state, this.historyKeys.slice(0, -1));
    this.searcher.newGame(); // pool freed; a fresh search builds the tree again
    return true;
  }

  resign() {
    if (this.isOver()) return false;
    this.result = { status: 'resignation', winner: -this.state.turn };
    return true;
  }

  // HINDSIGHT: re-analyze a past decision with deeper search (the engine's own
  // "backtrace" after a path failed — the game-depth search can't reveal it
  // because the chosen move was the max of its rootScores). If a clearly
  // better alternative exists at the higher depth, record it as an exception
  // at the ORIGINAL difficulty.
  _hindsight(entry, boost = 2) {
    const state = fenToState(entry.fen);
    const hist = this.historyKeys.slice(0, entry.histLen);
    const res = this.searcher.search(state, entry.difficulty + boost, {
      historyKeys: hist,
      timeLimitMs: this.timeLimitMs || 0,
    });
    const chosen = entry.chosen;
    const chosenScore = res.rootScores.find(([m]) => m === chosen)?.[1] ?? res.score;
    let bestAlt = 0, bestAltScore = -Infinity;
    for (const [m, s] of res.rootScores) {
      if (m !== chosen && s > bestAltScore) { bestAltScore = s; bestAlt = m; }
    }
    if (bestAlt && bestAltScore >= chosenScore + IMPROVEMENT_CP) {
      this.learner.record(entry.difficulty, state, chosen, bestAlt, 'loss-backtrace');
      return { poskey: entry.poskey, badMove: chosen, goodMove: bestAlt, why: 'loss-backtrace' };
    }
    return null;
  }

  // Called when the engine lost the game (checkmate or resignation): walk the
  // decision log back from the loss to the FIRST board where hindsight finds a
  // clearly-better alternative, and record it.
  learnFromLoss() {
    if (!this.learner.enabled) return null;
    for (let i = this.log.length - 1; i >= 0; i--) {
      const ex = this._hindsight(this.log[i]);
      if (ex) {
        this.learned = { ...ex, badMove: [ex.badMove], goodMove: ex.goodMove };
        this.searcher.clearSearchState();
        return ex;
      }
    }
    return null;
  }
}
