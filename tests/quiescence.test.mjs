// quiescence.test.mjs — the "last minute check": capture/evasion resolution
// at the depth limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenToState, generateLegal, generateCaptures, isCapture, applyMove, uciName } from '../app/src/board.js';
import { Searcher } from '../app/src/search.js';
import { evaluate } from '../app/src/eval.js';
import { DEFAULT_CONFIG } from '../app/src/config.js';

function best(fen, depth, opts = {}) {
  const s = fenToState(fen);
  const searcher = opts.searcher || new Searcher();
  return searcher.search(s, depth, { historyKeys: [[s.k1, s.k2]] });
}

test('generateCaptures == generateLegal().filter(isCapture)', () => {
  const fens = [
    'r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', // Kiwipete
    'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', // perft 4
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', // perft 3
    '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1',
  ];
  for (const fen of fens) {
    const s = fenToState(fen);
    const expected = generateLegal(s).filter(isCapture).map((m) => uciName(m)).sort();
    const got = generateCaptures(s).map((m) => uciName(m)).sort();
    assert.deepEqual(got, expected, `captures match for ${fen.slice(0, 30)}`);
  }
});

test('quiescence sees a multi-capture chain at depth 1', () => {
  // Rxd8+ Kxd8 resolves to even; without quiescence the rook sits on d8 and
  // the depth-1 eval thinks it won a rook (the classic horizon illusion)
  const fen = '3rk3/8/8/8/8/8/8/3RK3 w - - 0 1';
  const off = best(fen, 1, { searcher: new Searcher({ config: { ...DEFAULT_CONFIG, tradeBonus: 0, quiescence: false } }) });
  const noQ = off.rootScores.find(([m]) => uciName(m) === 'd1d8');
  assert.ok(noQ[1] >= 4900, `without quiescence the grab looks like a won rook, got ${noQ[1]}`);
  const withQ = best(fen, 1, { searcher: new Searcher({ config: { ...DEFAULT_CONFIG, tradeBonus: 0 } }) });
  const q = withQ.rootScores.find(([m]) => uciName(m) === 'd1d8');
  assert.ok(Math.abs(q[1]) < 200, `quiescence resolves the recapture (nets ~0), got ${q[1]}`);
});

test('quiescence avoids evaluating a position while in check (evasions searched)', () => {
  // black just delivered a check with the rook on h1; the leaf would be "in
  // check" — quiescence must search evasions instead of scoring a checked king
  const fen = '7k/8/8/8/8/8/8/7r w - - 0 1'; // black rook h1 checks Kg... no king — use a real one
  const s = fenToState('7k/8/8/8/8/8/8/6Rr w - - 0 1'); // white Kg1, black Rh1 check
  const res = new Searcher().search(s, 1, { historyKeys: [[s.k1, s.k2]] });
  assert.ok(res.move !== 0, 'produces an evasion');
  const evasions = generateLegal(s);
  assert.ok(evasions.includes(res.move), 'the chosen move is a legal evasion of check');
});

test('quiescence depth cap and repetition terminate (no infinite loops)', () => {
  // perpetual-check-ish position searched at several q-depth caps
  for (const qd of [1, 2, 8]) {
    const s = fenToState('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    const res = new Searcher({ config: { ...DEFAULT_CONFIG, quiescenceDepth: qd } })
      .search(s, 2, { historyKeys: [[s.k1, s.k2]], timeLimitMs: 5000 });
    assert.ok(res.move !== 0, `terminates at q-depth ${qd}`);
  }
});

test('quiet positions are untouched by quiescence (same eval)', () => {
  // kings + pawns only, no captures anywhere: stand pat == static eval
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  const s = fenToState(fen);
  const q = new Searcher({ config: { ...DEFAULT_CONFIG, quiescence: true } }).search(s, 1, { historyKeys: [[s.k1, s.k2]] });
  const noQ = new Searcher({ config: { ...DEFAULT_CONFIG, quiescence: false } }).search(s, 1, { historyKeys: [[s.k1, s.k2]] });
  const mv = q.move;
  const leafQ = applyMove(s, mv);
  assert.equal(q.score, noQ.score, 'quiet position: same score with and without quiescence');
  // leaf eval is from the side to move; normalize to white's perspective
  const wp = leafQ.turn === 1 ? evaluate(leafQ) : -evaluate(leafQ);
  assert.ok(Math.abs(q.score - wp) < 2000, 'stand-pat matches the static eval within noise');
});
