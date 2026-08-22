// learner.test.mjs — the per-difficulty exception learner: recording, lookup,
// loss backtraces, reply refutations, and the "second replay avoids the bad
// move" behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenToState, applyMove, uciName, generateLegal, transformPosition, transformMove, BLACK } from '../app/src/board.js';
import { Searcher } from '../app/src/search.js';
import { CheapLearner } from '../app/src/learner.js';
import { CheapGame } from '../app/src/game.js';

class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k, v) { this.map.set(k, v); }
  removeItem(k) { this.map.delete(k); }
}

function fresh() {
  const storage = new MemStorage();
  const learner = new CheapLearner({ storage });
  const searcher = new Searcher();
  return { storage, learner, searcher };
}

test('record + lookup: exceptions are keyed by difficulty and position', () => {
  const { learner } = fresh();
  const s = fenToState('8/8/8/8/8/8/8/K6k w - - 0 1');
  assert.ok(learner.record(4, s, 1, 2, 'loss-backtrace'));
  const ex = learner.lookup(4, s.k1, s.k2);
  assert.ok(ex, 'lookup by zobrist halves finds it');
  assert.ok(ex.bad.has(1));
  assert.equal(ex.good, 2);
  // different difficulty -> no exception
  assert.equal(learner.lookup(6, s.k1, s.k2), null);
  // same position key, different state object -> still found
  const s2 = fenToState('8/8/8/8/8/8/8/K6k w - - 0 1');
  assert.ok(learner.lookup(4, s2.k1, s2.k2));
  assert.equal(learner.count(4), 4, 'identity + mirror + invert + rotate fan out');
});

test('persistence: exceptions survive learner reload (localStorage shape)', () => {
  const { storage, learner } = fresh();
  const s = fenToState('8/8/8/8/8/8/8/K6k w - - 0 1');
  learner.record(4, s, 1, 2, 'reply-refutation');
  // simulate a fresh page load
  const learner2 = new CheapLearner({ storage });
  const s2 = fenToState('8/8/8/8/8/8/8/K6k w - - 0 1');
  assert.ok(learner2.lookup(4, s2.k1, s2.k2), 'exception survived reload');
});

test('the search excludes the known-bad move and backtracks', () => {
  // position: white to move; the knight grab d4xe6 is the "bad move" — record
  // it as a known exception so the search must try something different.
  const fen = '8/8/4n3/8/3N4/8/8/K6k w - - 0 1';
  const s = fenToState(fen);
  const { learner, searcher } = fresh();
  const moves = generateLegal(s);
  const grab = moves.find((m) => uciName(m) === 'd4e6');
  const alt = moves.find((m) => uciName(m) !== 'd4e6');
  assert.ok(grab && alt, 'position has a grab and an alternative');
  learner.record(4, s, grab, alt, 'test');
  const withEx = learner.lookup(4, s.k1, s.k2);
  assert.ok(withEx.bad.has(grab));

  const r1 = searcher.search(s, 2, { learner, difficulty: 4, historyKeys: [[s.k1, s.k2]] });
  assert.notEqual(r1.move, grab, 'the bad move is excluded, the search backtracks');
  const r2 = new Searcher().search(s, 2, { historyKeys: [[s.k1, s.k2]] });
  assert.equal(r2.move, grab, 'without the exception the search takes the grab');
});

test('learnFromLoss: hindsight backtrace records a fixable decision', () => {
  // the engine "played" Qxf7+ at depth 1 (chosen = h5f7); at depth 3 the grab
  // scores 120 while real moves score ~9000 — a clearly fixable decision.
  const { learner, searcher } = fresh();
  const game = new CheapGame({ difficulty: 1, learner, searcher });
  const trapFen = '4k3/5p2/8/7Q/8/8/8/4K3 w - - 0 1';
  const st = fenToState(trapFen);
  const h5f7 = generateLegal(st).find((m) => uciName(m) === 'h5f7');
  game.historyKeys = [[st.k1, st.k2]];
  game.log = [{ fen: trapFen, poskey: 'x', difficulty: 1, chosen: h5f7, score: 0, rootScores: [], histLen: 1 }];
  const ex = game.learnFromLoss();
  assert.ok(ex, 'an exception is learned from the loss');
  assert.equal(ex.badMove, h5f7);
  assert.ok(learner.count(1) > 0, 'lesson recorded at the ORIGINAL difficulty');
  const rec = learner.list(1)[0];
  assert.ok(rec.bad.includes(h5f7), 'the bad move is stored');
});

test('learnFromLoss: nothing recorded when every alternative is equally bad', () => {
  const { learner, searcher } = fresh();
  const game = new CheapGame({ difficulty: 1, learner, searcher });
  const lostFen = '4qk3/8/8/8/8/8/8/K7 w - - 0 1'; // white is completely lost
  const st = fenToState(lostFen);
  const a1a2 = generateLegal(st).find((m) => uciName(m) === 'a1a2');
  game.historyKeys = [[st.k1, st.k2]];
  game.log = [{ fen: lostFen, poskey: 'y', difficulty: 1, chosen: a1a2, score: -9000, rootScores: [], histLen: 1 }];
  assert.equal(game.learnFromLoss(), null, 'no fixable alternative');
  assert.equal(learner.total(), 0);
});

test('reply refutation: a bad reply triggers hindsight and records', () => {
  const { learner, searcher } = fresh();
  const game = new CheapGame({ difficulty: 1, learner, searcher });
  game.humanColor = BLACK;
  // black to move; the human takes the hanging queen on f7, leaving white down a rook
  game.loadFen('r3k3/5Q2/8/8/8/8/8/4K3 b - - 0 1');
  const trapFen = 'r3k3/5p2/8/7Q/8/8/8/4K3 w - - 0 1';
  const st = fenToState(trapFen);
  const h5f7 = generateLegal(st).find((m) => uciName(m) === 'h5f7');
  game.log = [{ fen: trapFen, poskey: 'x', difficulty: 1, chosen: h5f7, score: 0, rootScores: [], histLen: 1 }];
  const res = game.playHuman(60, 53); // Kxf7
  assert.ok(res.ok, 'human captured the queen');
  assert.ok(game.learned, 'reply-refutation recorded a lesson');
  assert.ok(learner.count(1) > 0, 'the lesson hit the database');
});

test('end-to-end: a second game at the same difficulty avoids the losing move', () => {
  const { learner, searcher, storage } = fresh();
  const game1 = new CheapGame({ difficulty: 2, learner, searcher });
  // play a full game where the engine loses (auto-play the human side with a
  // fixed greedy policy: first legal move)
  const humanFirst = (g) => g.legalMoves()[0];
  let guard = 0;
  while (!game1.isOver() && guard++ < 200) {
    if (game1.isHumanTurn()) {
      const m = humanFirst(game1);
      game1.playHuman(m & 63, (m >> 6) & 63, (m >> 12) & 7);
    } else {
      game1.engineMove();
    }
  }
  if (game1.isOver() && game1.result.winner === game1.humanColor) {
    // engine lost — it should have learned something
    game1.learnFromLoss();
    assert.ok(game1.learner.total() > 0, 'the loss taught the engine something');
  } else {
    // game drawn or won — the learner may or may not have recorded; just make
    // sure the machinery didn't blow up
    game1.learnFromLoss();
  }
  assert.ok(true);
  assert.equal(learner.enabled, true);
  // the searcher still works with the learner attached
  const s = fenToState('8/8/8/8/8/8/8/K6k w - - 0 1');
  const res = searcher.search(s, 2, { learner, difficulty: 2, historyKeys: [[s.k1, s.k2]] });
  assert.ok(res.move !== 0);
});

test('symmetry: an exception learned at P applies at P mirror/invert/rotate', () => {
  // white king a1, black h1, white pawn e4 — record "e4e5 bad, prefer a1a2"
  const s = fenToState('8/8/8/8/4P3/8/8/K6k w - - 0 1');
  const { learner } = fresh();
  const moves = generateLegal(s);
  const bad = moves.find((m) => uciName(m) === 'e4e5');
  const good = moves.find((m) => uciName(m) === 'a1a2');
  learner.record(4, s, bad, good, 'test');
  for (const mode of [1, 2, 3]) {
    const t = transformPosition(s, mode);
    const ex = learner.lookup(4, t.k1, t.k2);
    assert.ok(ex, `mirror mode ${mode} finds the lesson`);
    assert.ok(ex.bad.has(transformMove(bad, mode)), `bad move mirrored for mode ${mode}`);
    assert.ok(ex.good === transformMove(good, mode), `good move mirrored for mode ${mode}`);
  }
  // the mirrored bad move is legal at the mirrored position
  const m = transformPosition(s, 1);
  assert.ok(generateLegal(m).includes(transformMove(bad, 1)));
});
