# Cheap Chess

A WebAX chess application: **fixed-size search pool · center-control scoring ·
per-difficulty exception learning · trading personality · UCI-ready**.

SPA + PWA, no build step, no Docker. The browser is the OS.

## Quick start

```bash
# serve the project root over http (the app is in app/)
python3 -m http.server 8080 --directory ..
# open http://localhost:8080/Cheap-Chess/app/
```

Install as an app: Chrome/Edge → the install icon (or the browser menu) → PWA.

Run the tests:

```bash
npm test            # 43 tests: perft suite, search, learner, UCI
```

Run it as a UCI engine (competition mode):

```bash
printf 'uci\nisready\nposition startpos\ngo depth 4\nquit\n' | npm run uci
```

## What it does

- **Search** — iterative deepening negamax (alpha-beta) to a difficulty-
  controlled depth (default 4 plies). The move tree lives in a **fixed-size
  node pool**; each turn the branches for moves that weren't played are freed
  and the played line is kept, so the tree from the start of the game grows
  one level deeper every turn.
- **Scoring** (1 pawn = 1000 points) — pawn 1000, knight/bishop 3000, rook
  5000, queen 9000, king = game; center control is 10 points per potential
  move into d4/d5/e4/e5 (empty, enemy-, or friendly-occupied all count), so
  the whole center is worth less than a single pawn. It picks the path that
  (a) doesn't lose and (b) reaches the highest board score.
- **Engine profile** — every scoring knob is a control: piece values, center
  control, check bonus, threat bonus, trade bonus, and mate score, with
  presets (Classic / Trader / Center / Materialist). The **New Game** screen
  asks your side (white/black) and the personality. The learner's exception
  cache is namespaced by a fingerprint of the whole profile, so lessons
  learned under one set of settings are never applied under another.
- **Trading personality** — if there's no risk in a trade, it happily trades
  (small root bonus for captures; never overrides a losing exchange).
- **Learning** — if a path it chose fails (a reply refutes it, or it loses),
  it backtraces the decision log to the first board where a clearly better
  alternative existed and stores an exception **for that difficulty**. On a
  later play at the same difficulty, hitting a known exception board makes the
  search backtrack and try something different. Exceptions persist in
  localStorage and can be exported/imported.
- **Rules** — full standard chess: castling, en passant, promotion (engine
  always picks a Queen; the human gets a chooser), checkmate, stalemate,
  50-move, threefold repetition, insufficient material. Move generation is
  validated to the exact node counts of the classic perft suite.
- **Competition** — UCI (the standard engine protocol), including tournament
  time controls: `go movetime N` / `go wtime W btime B winc WI binc BI`.
  Under a clock it deepens until the budget is spent and plays whatever it
  got from the last fully-completed depth. Normal play has no time limit.

## Web component

```html
<cheap-chess difficulty="4" color="white" learning="true"></cheap-chess>
```

Click (or arrow keys + Enter) to move. **New Game…** opens the engine
personality screen: your side, difficulty (1–14 plies; 14 = 7 turns, each
move self-limits at ~20s), piece values, center control, check/threat/trade
bonuses, mate score, presets, and the learning toggle. From difficulty 6 the
search splits the root moves across up to 8 Web Workers (your cores), which
buys roughly one extra ply within the time budget. The panel keeps quick
controls (difficulty, undo, resign, learning, exceptions export/import), the
SAN move list, per-search stats (depth, nodes, threads), and the profile
fingerprint. Eval bar shows your advantage and the engine's principal
variation. State and exceptions survive reloads.

## Layout

```
Cheap-Chess/
├── app/                 # the SPA/PWA (served statically, no build step)
│   ├── index.html, styles.css, manifest.json, service-worker.js, icons/
│   └── src/             # board.js · eval.js · search.js · learner.js ·
│                        # game.js · san.js · uci.js · chess-board.js ·
│                        # chess-worker.js · main.js
├── develop/
│   ├── cheap-chess-uci.mjs   # UCI engine over stdin/stdout
│   └── tools/                # icon generator, python perft reference
├── specs/               # chess-rules.md · engine.md · uci.md
├── docs/EVALUATION.md   # what the brief left out, and how it was resolved
├── tests/               # perft.test.mjs · search.test.mjs · learner.test.mjs · uci.test.mjs
└── webax.json           # WebAX config (comlink API surface declared)
```

## Key decisions worth knowing

- **King safety** is on by default (pawn shield, open files, castled bonus —
  it castles now — and a wandering-king penalty), tunable via
  `kingSafetyPoints`.
- **Quiescence** ("the last minute check") is on: at the depth limit the
  search resolves remaining captures (and check evasions) before scoring, so
  it never evaluates a board mid-tactic. Worth ~2 plies of fixed-depth search
  (self-play: depth-4-with-q beat depth-6-without-q 3-3). Tunable in the New
  Game screen / UCI (`Quiescence`, `QuiescenceDepth`).
- **Center control dominates**: 200cp per square, so the engine fights for the
  center first and trades second — the trading personality is a tiebreaker,
  not an override.
- **Deterministic**: same position + difficulty + exceptions → same move
  (fresh searcher). The learner relies on this for reproducible replays.
- **No Docker** — it's a plain static PWA, like any normal WebAX application.
