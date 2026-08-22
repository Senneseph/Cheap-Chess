// keys.test.mjs — zobrist key consistency regression: the incremental key path
// (applyMove) and the from-scratch paths (startState / fenToState /
// transformPosition) MUST produce identical keys for the same position, or
// the learner's lookups silently never match (a real bug this test caught).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startState, fenToState, stateToFen, generateLegal, applyMove, uciName, transformPosition, TRANSFORM_MODES } from '../app/src/board.js';

test('incremental keys match from-scratch keys across a castling + captures line', () => {
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5', 'f6d5', 'c4d5', 'd8d5', 'e1g1'];
  let s = startState();
  for (const mv of moves) {
    const m = generateLegal(s).find((x) => uciName(x) === mv);
    assert.ok(m, `move ${mv} legal`);
    s = applyMove(s, m);
    const f = fenToState(stateToFen(s));
    assert.equal(s.k1, f.k1, `k1 consistent after ${mv}`);
    assert.equal(s.k2, f.k2, `k2 consistent after ${mv}`);
  }
  // every transform also round-trips
  for (const mode of TRANSFORM_MODES) {
    const t = transformPosition(s, mode);
    const t2 = fenToState(stateToFen(t));
    assert.equal(t.k1, t2.k1, `transform ${mode} k1 round-trips`);
    assert.equal(t.k2, t2.k2, `transform ${mode} k2 round-trips`);
  }
});

test('black-to-move and white-to-move positions both key consistently', () => {
  // the turn-key convention bug: it must be present iff white is to move
  const w = fenToState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const b = fenToState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  assert.notEqual(w.k1, b.k1, 'side to move changes the key');
  // playing e2e4 then re-parsing gives identical keys (regression for the
  // learner-lookup-never-matches bug)
  const e4 = generateLegal(w).find((m) => uciName(m) === 'e2e4');
  const after = applyMove(w, e4);
  const reparsed = fenToState(stateToFen(after));
  assert.equal(after.k1, reparsed.k1);
  assert.equal(after.k2, reparsed.k2);
});
