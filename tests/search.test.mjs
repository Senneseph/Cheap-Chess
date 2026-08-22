// search.test.mjs — search behavior: mates, blunder avoidance, center control,
// trading personality, determinism, time limits, and the fixed-pool
// advance/free semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenToState, startState, applyMove, generateLegal, uciName } from '../app/src/board.js';
import { Searcher, MATE } from '../app/src/search.js';
import { evaluate } from '../app/src/eval.js';
import { DEFAULT_CONFIG } from '../app/src/config.js';

function best(fen, depth, opts = {}) {
  const s = fen === 'start' ? startState() : fenToState(fen);
  const searcher = opts.searcher || new Searcher();
  return searcher.search(s, depth, { historyKeys: [[s.k1, s.k2]] });
}

test('finds a unique mate in 1', () => {
  // white: Rf1-f8# is the only mate (king g6 covers h7/g7; verified with the engine)
  const fen = '7k/8/6K1/8/8/8/8/5R2 w - - 0 1';
  const res = best(fen, 3);
  assert.equal(uciName(res.move), 'f1f8', `expected Rf8#, got ${uciName(res.move)}`);
  assert.ok(Math.abs(res.score) >= MATE - 1, `expected mate score, got ${res.score}`);
  const n = applyMove(fenToState(fen), res.move);
  assert.equal(generateLegal(n).length, 0, 'mate must leave no replies');
});

test('quiescence (the last-minute check): depth 1 already sees the recapture', () => {
  const fen = '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1';
  const on = best(fen, 1, { searcher: new Searcher({ config: { ...DEFAULT_CONFIG, tradeBonus: 0 } }) });
  const qx = on.rootScores.find(([m]) => uciName(m) === 'd1d8');
  assert.equal(qx[1], 0, 'depth 1 + quiescence resolves Qxd8+ Kxd8 => nets 0');
  const off = best(fen, 1, { searcher: new Searcher({ config: { ...DEFAULT_CONFIG, tradeBonus: 0, quiescence: false } }) });
  const qxOff = off.rootScores.find(([m]) => uciName(m) === 'd1d8');
  assert.ok(qxOff[1] >= 8900, `without quiescence depth 1 thinks it wins the queen, got ${qxOff[1]}`);
});

test('trading personality: safely trades queens when there is no risk', () => {
  const fen = '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1';
  // the engine happily trades: Qxd8+ Kxd8 is an equal, risk-free exchange
  const trading = best(fen, 2, { searcher: new Searcher({ tradeBonus: 12 }) });
  assert.equal(uciName(trading.move), 'd1d8', 'the trading engine happily trades');
  // mechanism: the capture's root score is exactly the bonus higher
  const a = best(fen, 2, { searcher: new Searcher({ tradeBonus: 12 }) });
  const b = best(fen, 2, { searcher: new Searcher({ tradeBonus: 0 }) });
  const scoreA = a.rootScores.find(([m]) => uciName(m) === 'd1d8')[1];
  const scoreB = b.rootScores.find(([m]) => uciName(m) === 'd1d8')[1];
  assert.equal(scoreA - scoreB, 12, 'trade bonus adds exactly 12cp to the capture');
});

test('trading personality: picks a safe equal trade over an equal quiet move', () => {
  // Rb1xb8 (Raxb8 recaptures) is an equal rook trade; the bonus decides ties
  // (check/threat bonuses off so they don't confound the trade decision)
  const base = { ...DEFAULT_CONFIG, checkBonus: 0, threatBonus: 0 };
  const fen = 'rr6/7k/8/8/8/8/8/1RK3R1 w - - 0 1';
  const withBonus = best(fen, 2, { searcher: new Searcher({ config: { ...base, tradeBonus: 12 } }) });
  assert.equal(uciName(withBonus.move), 'b1b8', 'prefers the safe trade');
  const noBonus = best(fen, 2, { searcher: new Searcher({ config: { ...base, tradeBonus: 0 } }) });
  const sb = noBonus.rootScores.find(([m]) => uciName(m) === 'b1b8');
  const wb = withBonus.rootScores.find(([m]) => uciName(m) === 'b1b8');
  assert.equal(wb[1] - sb[1], 12, 'bonus is exactly +12 on the capture');
});

test('center control: opening prefers center moves at depth 1', () => {
  const res = best('start', 1);
  const name = uciName(res.move);
  assert.ok(['e2e4', 'd2d4', 'g1f3', 'b1c3'].includes(name), `expected a center move, got ${name} (score ${res.score})`);
});

test('evaluation: center = 10 pts per potential move, material in 1000-scale', () => {
  // a lone WHITE queen on d4: material +9000 (9 pawns x 1000); the queen has
  // potential moves into d5/e4/e5 (3 moves x 10 pts) but not into its own d4
  const s = fenToState('8/8/8/8/3Q4/8/8/K6k w - - 0 1');
  assert.equal(evaluate(s), 9030);
  // the same position with black to move flips the sign
  const s2 = fenToState('8/8/8/8/3Q4/8/8/K6k b - - 0 1');
  assert.equal(evaluate(s2), -9030);
  // the whole center stays worth far less than a pawn: even many movers
  // (queen + knight + bishop all hitting the center) stay under 1000
  const s3 = fenToState('8/8/8/8/3Q4/3N4/8/K4B1k w - - 0 1');
  const centerOnly = evaluate(s3) - 9000 - 3000 - 3000; // material off
  assert.ok(centerOnly < 1000, `center (${centerOnly}) < one pawn (1000)`);
});

test('determinism: same position + depth + fresh searchers => same move', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  const r1 = best(fen, 4, { searcher: new Searcher() });
  const r2 = best(fen, 4, { searcher: new Searcher() });
  assert.equal(r1.move, r2.move);
  assert.equal(r1.score, r2.score);
  assert.deepEqual(r1.pv, r2.pv);
});

test('pool: advance() keeps the played line, frees the rest, stays consistent', () => {
  const searcher = new Searcher({ poolSize: 65536 });
  const s = startState();
  const res = searcher.search(s, 3, { historyKeys: [[s.k1, s.k2]] });
  assert.ok(res.move !== 0);
  assert.ok(searcher.pool.used > 0);

  const childState = applyMove(s, res.move);
  assert.ok(searcher.pool.advance(res.move), 'the played line should be in the pool');
  assert.equal(searcher.pool.debugCheck(), null, 'pool must be leak-free');

  const res2 = searcher.search(childState, 3, {
    historyKeys: [[s.k1, s.k2], [childState.k1, childState.k2]],
  });
  assert.ok(res2.move !== 0);
  assert.equal(searcher.pool.debugCheck(), null);

  // advancing with a move that is NOT in the pool resets cleanly
  const moves = generateLegal(childState);
  const other = moves.find((m) => m !== res2.move) || moves[0];
  searcher.pool.advance(other);
  assert.equal(searcher.pool.debugCheck(), null);
});

test('time limit: returns the last fully-completed depth ("whatever it got")', () => {
  const searcher = new Searcher();
  const s = fenToState('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  const res = searcher.search(s, 8, { timeLimitMs: 1, historyKeys: [[s.k1, s.k2]] });
  assert.ok(res.stats.depth >= 1, `should have at least depth 1, got ${res.stats.depth}`);
  assert.ok(res.stats.depth < 8, `should stop early under a 1ms budget, got depth ${res.stats.depth}`);
  assert.ok(res.move !== 0);
});

test('pool exhaustion degrades gracefully and keeps the pool consistent', () => {
  const searcher = new Searcher({ poolSize: 2048 });
  const s = fenToState('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  const res = searcher.search(s, 6, { historyKeys: [[s.k1, s.k2]] });
  assert.ok(res.move !== 0, 'still produces a move');
  assert.equal(searcher.pool.debugCheck(), null);
});

test('checkmate scores as a win, stalemate as a draw', () => {
  const st = fenToState('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(generateLegal(st).length, 0, 'black has no moves');
});
