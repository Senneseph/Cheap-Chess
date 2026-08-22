// chess-worker.js — runs a single Cheap Chess search (or a root-move slice)
// off the main thread. Used both by the app (Web Worker) and the UCI CLI
// (worker_threads).
//
// Messages in:
//   { id, type: 'search', ... }                 full iterative-deepening search
//   { id, type: 'search-slice', ... }           one depth round of root moves
//   (see parallel-search.js for the round protocol)
// Messages out:
//   { id, type: 'search-result', ... }          full search result
//   { id, type: 'slice-result', ... }           slice scores + best + pv

import { Searcher } from './search.js';
import { CheapLearner, MemoryStorage } from './learner.js';
import { initZobrist } from './board.js';

// CRITICAL: zobrist tables are initialized lazily by startState/fenToState,
// which run in the main thread — a bare worker never calls them, leaving the
// tables all-zero so every position keys identically and the search collapses
// into fake "repetition draws". Initialize explicitly before searching.
initZobrist();

// ---- transport shim (browser `self` vs Node worker_threads) --------------

const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;

let post = null;
let on = null;
if (isNode) {
  // dynamic import so the browser bundle never resolves 'node:worker_threads'
  const wt = await import('node:worker_threads');
  post = (m) => wt.parentPort.postMessage(m);
  on = (cb) => wt.parentPort.on('message', (msg) => cb(msg));
} else {
  post = (m) => self.postMessage(m);
  on = (cb) => { self.onmessage = (e) => cb(e.data); };
}

// ---- search handlers -------------------------------------------------------

function makeLearner(msg) {
  const learner = new CheapLearner({ storage: new MemoryStorage() });
  learner.enabled = true;
  if (msg.exceptions && msg.exceptions.length) {
    learner.importCompact(msg.difficulty, msg.exceptions);
  }
  return learner;
}

function optsFor(msg) {
  return {
    learner: makeLearner(msg),
    difficulty: msg.difficulty,
    historyKeys: msg.historyKeys,
    timeLimitMs: msg.timeLimitMs || 0,
  };
}

on(async (msg) => {
  if (!msg) return;

  if (msg.type === 'search') {
    const searcher = new Searcher({ poolSize: msg.poolSize || undefined, config: msg.config });
    const res = searcher.search(msg.state, msg.depth, optsFor(msg));
    post({
      id: msg.id, type: 'search-result',
      move: res.move, score: res.score, pv: res.pv, rootScores: res.rootScores, stats: res.stats,
    });
    return;
  }

  if (msg.type === 'search-slice') {
    // the orchestrator partitioned the root moves; each worker runs the FULL
    // iterative-deepening search on its slice (running alpha, no noise — the
    // merge is exact), reporting depth reached so the orchestrator can merge.
    const searcher = new Searcher({ poolSize: msg.poolSize || undefined, config: { ...msg.config, evalNoiseSeed: 0 } });
    const res = searcher.search(msg.state, msg.depth, {
      ...optsFor(msg),
      rootMoves: msg.moves,
      onIteration: null,
    });
    post({
      id: msg.id, type: 'slice-result',
      move: res.move, score: res.score, pv: res.pv, scores: res.rootScores, stats: res.stats,
    });
    return;
  }
});
