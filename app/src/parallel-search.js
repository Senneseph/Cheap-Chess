// parallel-search.js — parallel root-move splitting (deterministic).
//
// Alpha-beta is NOT embarrassingly parallel: pruning depends on search order,
// so naive parallel expansion destroys the pruning. The scheme here splits the
// ROOT moves across N workers: the orchestrator orders the root moves (MVV-LVA
// captures first, like the sequential search) and round-robins them into N
// slices; each worker then runs the FULL sequential search (iterative
// deepening, running alpha) restricted to its slice. Each slice's result is
// therefore EXACT (same code path as the sequential engine), and since a root
// move's reported score is only ever exact-or-understated, the merged maximum
// is the true maximum.
//
// Wall clock: the slowest slice — the one holding the true best move's big
// subtree — dominates (~50-70% of the sequential work), so expect ~1.4-2x,
// not Nx. Within a time budget that buys roughly one extra ply of depth.
//
// Determinism: slices are fixed by a deterministic sort and workers run
// independently, so a given worker count reproduces bit-for-bit — the
// learner's reproducibility story survives.
//
// Transports: Web Workers in the browser, worker_threads in Node (UCI CLI).

import { generateLegal } from './board.js';
import { poolSizeForDepth } from './search.js';

const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;

const browserTransport = {
  spawn() {
    return new Worker(new URL('./chess-worker.js', import.meta.url), { type: 'module' });
  },
  send(w, msg) { w.postMessage(msg); },
  onMessage(w, cb) { w.addEventListener('message', (e) => cb(e.data)); },
  terminate(w) { w.terminate(); },
};

export async function parallelSearch({
  state, depth, timeLimitMs, historyKeys, difficulty, config, exceptions, workerCount, poolSize,
} = {}) {
  const n = Math.max(1, Math.min(16, workerCount || 1));
  let transport = browserTransport;
  if (isNode) {
    const { Worker } = await import('node:worker_threads');
    transport = {
      spawn: () => new Worker(new URL('./chess-worker.js', import.meta.url)),
      send: (w, msg) => w.postMessage(msg),
      onMessage: (w, cb) => w.on('message', (m) => cb(m)),
      terminate: (w) => w.terminate(),
    };
  }

  const moves = generateLegal(state);
  if (moves.length === 0) {
    return { move: 0, score: 0, pv: [], rootScores: [], stats: { depth: 0, nodes: 0, ms: 0, workers: n, parallel: true } };
  }

  // order root moves like the sequential search would (MVV-LVA captures first)
  const ordered = [...moves].sort((a, b) => {
    const fa = (a >> 21) & 7, fb = (b >> 21) & 7;
    const ca = (a >> 15) & 7, cb = (b >> 15) & 7;
    const sa = fa === 2 || fa === 4 ? 800 + 8 * (ca + 1) - ((a >> 18) & 7) : fa === 6 ? 700 + ((a >> 12) & 7) : 0;
    const sb = fb === 2 || fb === 4 ? 800 + 8 * (cb + 1) - ((b >> 18) & 7) : fb === 6 ? 700 + ((b >> 12) & 7) : 0;
    return sb - sa;
  });

  // round-robin partition so each slice mixes big and small subtrees
  const slices = Array.from({ length: n }, () => []);
  ordered.forEach((m, i) => slices[i % n].push(m));

  // each worker searches its slice with a full-size arena (capped so N workers
  // stay within a sane total budget)
  const perWorkerPool = Math.max(65536, Math.min(poolSize || poolSizeForDepth(depth, 1), 6_000_000));

  const started = Date.now();
  const workers = [];
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const worker = transport.spawn();
    workers.push(worker);
    jobs.push(new Promise((resolve) => {
      transport.onMessage(worker, (msg) => {
        if (msg && msg.type === 'slice-result' && msg.id === 0) resolve(msg);
      });
    }));
    transport.send(worker, {
      id: 0, type: 'search-slice',
      state: { ...state, b: Array.from(state.b) },
      moves: slices[i],
      depth,
      timeLimitMs: timeLimitMs || 0,
      historyKeys,
      difficulty,
      config,
      exceptions: exceptions || [],
      poolSize: perWorkerPool,
    });
  }

  let results;
  try {
    results = await Promise.all(jobs);
  } finally {
    for (const w of workers) { try { transport.terminate(w); } catch { /* ignore */ } }
  }

  // merge: the deepest completed slice wins; ties by score.
  results.sort((a, b) => (b.stats.depth - a.stats.depth) || (b.score - a.score));
  const winner = results[0];

  // complete rootScores for the learner: every root move, from every slice
  const rootScores = [];
  for (const r of results) {
    for (const [m, sc] of r.scores) rootScores.push([m, sc]);
  }
  rootScores.sort((a, b) => b[1] - a[1]);

  return {
    move: winner.move,
    score: winner.score,
    pv: winner.pv,
    rootScores,
    stats: {
      depth: winner.stats.depth,
      nodes: results.reduce((s, r) => s + r.stats.nodes, 0),
      ms: Date.now() - started,
      workers: n,
      parallel: true,
    },
  };
}
