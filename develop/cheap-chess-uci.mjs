#!/usr/bin/env node
// cheap-chess-uci.mjs — run Cheap Chess as a UCI engine over stdin/stdout.
//
// Usage:
//   node develop/cheap-chess-uci.mjs
//   echo -e "uci\nisready\nposition startpos moves e2e4\ngo depth 4\nquit" | node develop/cheap-chess-uci.mjs
//
// Any UCI GUI (Arena, Cute Chess, BanksiaGUI...) or competition harness can
// drive the engine this way. Time controls: `go wtime X btime Y winc Z binc Z`
// or `go movetime N` — the engine deepens until the budget runs out and plays
// whatever it got from the last fully-completed depth.

import { createInterface } from 'node:readline';
import { CheapChessUCI } from '../app/src/uci.js';

const uci = new CheapChessUCI({ out: (line) => process.stdout.write(line + '\n') });

const pending = [];
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', (line) => {
  const p = uci.handle(line);
  if (p && typeof p.then === 'function') pending.push(p);
});
rl.on('close', async () => {
  // wait for any in-flight async (parallel) search before exiting
  await Promise.all(pending);
  process.exit(0);
});
