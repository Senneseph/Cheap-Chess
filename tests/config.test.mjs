// config.test.mjs — the engine profile system: fingerprinting, sanitization,
// parameterized eval/search, and the per-profile learner cache isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenToState, applyMove, generateLegal, uciName } from '../app/src/board.js';
import { evaluate, materialScore, centerScore, checkScore, threatScore, kingSafetyScore } from '../app/src/eval.js';
import { Searcher, MATE } from '../app/src/search.js';
import { CheapLearner } from '../app/src/learner.js';
import { CheapGame } from '../app/src/game.js';
import { DEFAULT_CONFIG, PRESETS, configFingerprint, sanitizeConfig } from '../app/src/config.js';

class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k, v) { this.map.set(k, v); }
  removeItem(k) { this.map.delete(k); }
}

test('fingerprint: same config => same fp, any knob change => different fp', () => {
  const a = configFingerprint(DEFAULT_CONFIG);
  const b = configFingerprint({ ...DEFAULT_CONFIG });
  assert.equal(a, b, 'identical configs hash identically');
  assert.equal(a, configFingerprint(sanitizeConfig({ ...DEFAULT_CONFIG, centerPoints: 10 })));
  assert.notEqual(a, configFingerprint({ ...DEFAULT_CONFIG, centerPoints: 4 }), 'center change changes fp');
  assert.notEqual(a, configFingerprint({ ...DEFAULT_CONFIG, pieceValues: [0, 2, 3, 3, 5, 9, 0] }), 'pawn value change changes fp');
  assert.notEqual(a, configFingerprint({ ...DEFAULT_CONFIG, checkBonus: 10 }));
  assert.notEqual(a, configFingerprint({ ...DEFAULT_CONFIG, threatBonus: 5 }));
  assert.notEqual(a, configFingerprint({ ...DEFAULT_CONFIG, tradeBonus: 30 }));
  assert.notEqual(a, configFingerprint({ ...DEFAULT_CONFIG, mateScore: 5000 }));
  assert.notEqual(a, configFingerprint({ ...DEFAULT_CONFIG, kingSafetyPoints: 50 }), 'king safety changes the profile');
  assert.equal(a, configFingerprint({ ...DEFAULT_CONFIG, kingSafetyPoints: 100 }));
});

test('sanitizeConfig clamps and normalizes', () => {
  const c = sanitizeConfig({ pieceValues: [0, 9, 3, 3, 5, 9, 0], centerPoints: 999, checkBonus: -5, mateScore: 10 });
  assert.deepEqual(c.pieceValues, [0, 9, 3, 3, 5, 9, 0]);
  assert.equal(c.centerPoints, 100);
  assert.equal(c.checkBonus, 0);
  assert.equal(c.mateScore, 10000);
  assert.equal(c.pieceValues[0], 0, 'empty square stays 0');
  assert.equal(c.pieceValues[6], 0, 'king stays 0');
});

test('eval respects custom piece values', () => {
  const s = fenToState('8/8/8/8/3Q4/8/8/K6k w - - 0 1');
  assert.equal(evaluate(s), 9030, 'default: queen 9000 + 3 center moves x 10');
  const cfg = { ...DEFAULT_CONFIG, pieceValues: [0, 1, 3, 3, 5, 50, 0] };
  assert.equal(evaluate(s, cfg), 50030, 'queen worth 50 pawns now');
});

test('eval respects center control value', () => {
  const s = fenToState('8/8/8/8/3Q4/8/8/K6k w - - 0 1');
  assert.equal(evaluate(s, { ...DEFAULT_CONFIG, centerPoints: 5 }), 9015); // 9000 + 3*5
  assert.equal(evaluate(s, { ...DEFAULT_CONFIG, centerPoints: 0 }), 9000);
});

test('king safety: castled+shielded king >> exposed wandering king', () => {
  // white: Kg1 with f2/g2/h2 pawns (shield 3, castled, no open files)
  // black: Ke6 in the open (no shield, centered, open files)
  const s = fenToState('8/8/4k3/8/8/8/5PPP/6K1 w - - 0 1');
  const ks = kingSafetyScore(s, DEFAULT_CONFIG);
  assert.ok(ks > 0, `safe king ahead, got ${ks}`);
  assert.equal(ks, 240, 'raw: (11 - (-13)) * 10 = 240');
  // with the knob off, the term vanishes
  assert.equal(kingSafetyScore(s, { ...DEFAULT_CONFIG, kingSafetyPoints: 0 }), 0);
});

test('king safety makes the engine castle', () => {
  // white can castle kingside (f1/g1 empty, h1 rook, not in check)
  const fen = '4k3/8/8/8/8/8/PPPPPPPP/4K2R w K - - 0 1';
  const s = fenToState(fen);
  const on = new Searcher({ config: DEFAULT_CONFIG }).search(s, 2, { historyKeys: [[s.k1, s.k2]] });
  assert.equal(uciName(on.move), 'e1g1', 'castles with king safety on');
  const off = new Searcher({ config: { ...DEFAULT_CONFIG, kingSafetyPoints: 0 } }).search(s, 2, { historyKeys: [[s.k1, s.k2]] });
  assert.notEqual(uciName(off.move), 'e1g1', 'without king safety it is indifferent');
});

test('check bonus and threat bonus are eval terms', () => {
  // white queen d1 checks the black king d8 (d-file clear) — check bonus applies
  const s = fenToState('3k4/8/8/8/8/8/8/3QK3 w - - 0 1');
  assert.equal(checkScore(s, { ...DEFAULT_CONFIG, checkBonus: 50 }), 50);
  assert.equal(checkScore(s, { ...DEFAULT_CONFIG, checkBonus: 0 }), 0);
  // threat: white queen d5 attacks the black rook a8 (d-file? no — rank 5... use a8? no)
  // white queen h5 attacks black rook e5 (rank) and black knight b5 (rank) => 2 threats
  const t = fenToState('8/8/8/1n2r2Q/8/8/8/K6k w - - 0 1');
  assert.equal(threatScore(t, { ...DEFAULT_CONFIG, threatBonus: 10 }), 20);
});

test('search uses the configured mate score', () => {
  const cfg = { ...DEFAULT_CONFIG, mateScore: 20000 };
  const s = fenToState('7k/8/6K1/8/8/8/8/5R2 w - - 0 1'); // Rf8#
  const res = new Searcher({ config: cfg }).search(s, 3, { historyKeys: [[s.k1, s.k2]] });
  assert.equal(uciName(res.move), 'f1f8');
  assert.ok(Math.abs(res.score) >= 20000 - 3 && Math.abs(res.score) < 20000, `mate scaled to configured score, got ${res.score}`);
});

test('learner cache is isolated per profile namespace', () => {
  const storage = new MemStorage();
  const s = fenToState('8/8/8/8/8/8/8/K6k w - - 0 1');
  const a = new CheapLearner({ storage, namespace: 'aaaa' });
  const b = new CheapLearner({ storage, namespace: 'bbbb' });
  a.record(4, s, 1, 2, 'test');
  assert.ok(a.lookup(4, s.k1, s.k2), 'recorded in profile aaaa');
  assert.equal(b.lookup(4, s.k1, s.k2), null, 'profile bbbb never sees it');
  assert.equal(a.count(4), 4, 'symmetry fan-out (identity+mirror+invert+rotate)');
  assert.equal(b.count(4), 0);
  // reloads stay isolated
  const a2 = new CheapLearner({ storage, namespace: 'aaaa' });
  const b2 = new CheapLearner({ storage, namespace: 'bbbb' });
  assert.ok(a2.lookup(4, s.k1, s.k2));
  assert.equal(b2.lookup(4, s.k1, s.k2), null);
});

test('CheapGame namespaces its own learner by the config fingerprint', () => {
  const g = new CheapGame({ config: { ...DEFAULT_CONFIG, centerPoints: 4 } });
  assert.equal(g.learner.namespace, configFingerprint(g.config));
});

test('search under a custom profile is deterministic and legal', () => {
  const cfg = PRESETS.Trader;
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  const s = fenToState(fen);
  const r1 = new Searcher({ config: cfg }).search(s, 4, { historyKeys: [[s.k1, s.k2]] });
  const r2 = new Searcher({ config: cfg }).search(s, 4, { historyKeys: [[s.k1, s.k2]] });
  assert.equal(r1.move, r2.move);
  const legal = generateLegal(s);
  assert.ok(legal.includes(r1.move), 'the chosen move must be legal');
  // trade bonus is applied at the root: a capture move's score includes it
  const fen2 = '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1';
  const st2 = fenToState(fen2);
  const res = new Searcher({ config: { ...DEFAULT_CONFIG, tradeBonus: 30 } }).search(st2, 2, { historyKeys: [[st2.k1, st2.k2]] });
  const qx = res.rootScores.find(([m]) => uciName(m) === 'd1d8');
  assert.equal(qx[1], 30);
});
