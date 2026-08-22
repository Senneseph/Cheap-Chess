// uci.test.mjs — the UCI (Universal Chess Interface) adapter, which is the
// "standard that would allow the engine to easily enter a competition".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheapChessUCI } from '../app/src/uci.js';
import { uciName } from '../app/src/board.js';

function makeUCI() {
  const lines = [];
  const uci = new CheapChessUCI({ out: (s) => lines.push(s) });
  return { uci, lines };
}

test('uci handshake', () => {
  const { uci, lines } = makeUCI();
  uci.handle('uci');
  assert.ok(lines.includes('uciok'));
  assert.ok(lines.some((l) => l.startsWith('id name CheapChess')));
  assert.ok(lines.some((l) => l.includes('option name Difficulty')));
  assert.ok(lines.some((l) => l.includes('option name Learning')));
  uci.handle('isready');
  assert.ok(lines.includes('readyok'));
});

test('position + go depth finds a move (and mate in 1)', () => {
  const { uci, lines } = makeUCI();
  uci.handle('position fen 7k/8/6K1/8/8/8/8/5R2 w - - 0 1');
  uci.handle('go depth 3');
  const best = lines.filter((l) => l.startsWith('bestmove')).at(-1);
  assert.ok(best, 'a bestmove line was emitted');
  assert.equal(best, 'bestmove f1f8');
  assert.ok(lines.some((l) => l.startsWith('info depth 3') && l.includes('score mate')));
});

test('position startpos moves + go', () => {
  const { uci, lines } = makeUCI();
  uci.handle('position startpos moves e2e4 e7e5 g1f3');
  uci.handle('go depth 2');
  const best = lines.filter((l) => l.startsWith('bestmove')).at(-1);
  assert.ok(best && /^bestmove [a-h][1-8][a-h][1-8]/.test(best), `got ${best}`);
});

test('go with a time budget respects it and still answers', () => {
  const { uci, lines } = makeUCI();
  uci.handle('position startpos');
  uci.handle('go movetime 1'); // 1ms budget — "go with whatever it got"
  const best = lines.filter((l) => l.startsWith('bestmove')).at(-1);
  assert.ok(best && best !== 'bestmove 0000', `got ${best}`);
  // at least one info depth line (depth >= 1)
  assert.ok(lines.some((l) => l.startsWith('info depth ')));
});

test('setoption difficulty + learning toggle', () => {
  const { uci } = makeUCI();
  uci.handle('setoption name Difficulty value 2');
  assert.equal(uci.options.Difficulty, 2);
  uci.handle('setoption name Learning value false');
  assert.equal(uci.learner.enabled, false);
  uci.handle('setoption name Learning value true');
  assert.equal(uci.learner.enabled, true);
  uci.handle('setoption name TradeBonus value 0');
  assert.equal(uci.config.tradeBonus, 0);
});

test('illegal moves in position are rejected', () => {
  const { uci, lines } = makeUCI();
  uci.handle('position startpos moves e2e5'); // illegal
  assert.ok(lines.some((l) => l.includes('illegal move')));
});

test('learner commands: learn list / clear', () => {
  const { uci, lines } = makeUCI();
  uci.handle('learn list');
  assert.ok(lines.some((l) => l.includes('no exceptions')));
  uci.handle('learn clear');
  uci.handle('learn list');
});

test('eval + perft + d extensions', () => {
  const { uci, lines } = makeUCI();
  uci.handle('position startpos');
  uci.handle('eval');
  assert.ok(lines.some((l) => l.includes('static eval')));
  uci.handle('perft 3');
  assert.ok(lines.some((l) => l.includes('perft(3) = 8902')));
  uci.handle('d');
  assert.ok(lines.some((l) => l.includes('FEN')));
});

test('ucinewgame resets the game', () => {
  const { uci } = makeUCI();
  uci.handle('position startpos moves e2e4');
  assert.ok(uci.game.moveList.length === 1);
  uci.handle('ucinewgame');
  assert.ok(uci.game.moveList.length === 0);
});

test('quit sets the exit flag', () => {
  const { uci } = makeUCI();
  assert.equal(uci.quit, false);
  uci.handle('quit');
  assert.equal(uci.quit, true);
});
