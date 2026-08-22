// perft.test.mjs — move generation correctness against the standard perft
// suite. If these pass, the rules engine (castling, en passant, promotion,
// check legality) is competition-correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perft, fenToState, startState } from '../app/src/board.js';

const cases = [
  // [fen, depth, expected]
  ['start', 1, 20],
  ['start', 2, 400],
  ['start', 3, 8902],
  ['start', 4, 197281],
  // Kiwipete (castling + en passant heavy)
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 1, 48],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 2, 2039],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
  // Position 3
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 1, 14],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 2, 191],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 3, 2812],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, 43238],
  // Position 4 (promotions)
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 1, 6],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 2, 264],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, 9467],
];

for (const [fen, depth, expected] of cases) {
  test(`perft ${fen === 'start' ? 'startpos' : fen} depth ${depth} = ${expected}`, () => {
    const s = fen === 'start' ? startState() : fenToState(fen);
    const t0 = Date.now();
    const got = perft(s, depth);
    const ms = Date.now() - t0;
    assert.equal(got, expected, `expected ${expected}, got ${got} (${ms}ms)`);
  });
}

// A slow but decisive sanity check at depth 5 on the start position.
test('perft startpos depth 5 = 4865609 (slow)', { timeout: 60000 }, () => {
  assert.equal(perft(startState(), 5), 4865609);
});
