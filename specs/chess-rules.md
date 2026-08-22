# Cheap Chess — chess rules contract

The rules engine (`app/src/board.js`) implements standard chess (FIDE-shaped),
verified against the classic perft suite (`tests/perft.test.mjs`): start
position 1–5, Kiwipete, positions 3 and 4 — all exact.

## Rules in scope

- Full legal move generation: pawns (single/double push, diagonal capture,
  promotion Q/R/B/N), knights, bishops, rooks, queens, kings, **castling**
  (rights, empty squares, not through/into check), **en passant** (with
  capturer normalization for repetition semantics).
- A move is legal iff it does not leave the mover's own king in check.
- Checkmate, stalemate, 50-move rule (100 half-moves), threefold repetition,
  insufficient material (KvK, K+minor vs K, K+B vs K+B same-colored bishops).
- Promotion: the engine always promotes to **Queen**. The UI offers the human
  Q/R/B/N with Queen highlighted.

## Scoring (points, 1 pawn = 1000, from the side to move's perspective)

| Thing | Default | Where |
|---|---|---|
| pawn | 1000 | `pieceValues[1]` |
| knight / bishop | 3000 | `pieceValues[2] / [3]` |
| rook | 5000 | `pieceValues[4]` |
| queen | 9000 | `pieceValues[5]` |
| king | game | `mateScore` (default 1000000) |
| center control | 10 / potential move | `centerPoints` |
| check bonus (opponent's king in check) | 50 | `checkBonus` |
| threat bonus (per enemy piece attacked) | 30 | `threatBonus` |
| capture bonus (trading personality, root) | 120 | `tradeBonus` |
| quiescence (last-minute capture/evasion resolution) | on, depth 6 | `quiescence`, `quiescenceDepth` |
| king safety (pawn shield, open files, castled, wandering king) | 100 | `kingSafetyPoints` |

**Center control** counts every *potential move* a piece can make into one of
the four center squares (d4 d5 e4 e5), at 10 points each. The target square
may be empty, enemy-occupied, or friendly-occupied — all count; sliders need a
clear path; a pawn's straight push counts only into an empty square, its
diagonal capture pattern always, and double pushes into d4/e4/d5/e5 count too.
Because each square counts multiple movers and 10 is tiny, the entire center
stays worth less than a single pawn (1000) in practice.

Every knob is part of the **engine profile** (`app/src/config.js`): piece
values, center control, check/threat/trade bonuses, mate score, quiescence, king safety. The learner's
exception cache is namespaced by a fingerprint of the whole profile, so
knowledge learned under one set of settings is **never** applied under another
(difficulty remains a per-record dimension inside the namespace).

Presets: **Classic** (the default spec above), **Trader** (trades eagerly),
**Center** (center-hugger), **Materialist** (pure material).

## Search

- Iterative deepening negamax with alpha-beta (fail-soft), depth = difficulty
  (default 4 plies, range 1–10).
- Move ordering: MVV-LVA captures, promotions, killer moves, history, and a
  **transposition table** (bounded, keyed by zobrist halves, deterministic
  overwrite) that reuses previous iterations' scores and best moves.
- Fixed-size node pool (`MovePool`, tiered by difficulty: 64k→3M nodes ≈
  1.3–60 MB). Each turn the played line is kept and the rest is freed
  (`pool.advance`). The TT makes the difficulty knob honest: depth 6 completes
  in ~0.5–1.5 s in middlegame positions; depth 7–8 degrade to best-so-far when
  the pool is exhausted (flagged in the stats).
- Repetition and 50-move draws are detected inside the search, so a losing
  engine takes the draw.
- Time-controlled mode (`timeLimitMs`): deepens until the budget is spent and
  returns the last fully-completed depth — "whatever it got."
- Normal play (the web app) has no time limit.

## Learning (per-difficulty exceptions)

`app/src/learner.js` stores, per difficulty (search depth) and position
(compact FEN key + zobrist halves for O(1) lookup):

```
{ bad: [moves that failed here], good: [move to prefer], why, times, at }
```

Created by:

1. **Reply refutation** — the human's reply makes the engine's position
   evaluate ≤ −2 pawns while a clearly better alternative existed at decision
   time.
2. **Loss backtrace** — the engine loses; walk the decision log back to the
   first decision where an alternative scored ≥ 1 pawn better than the chosen
   move, and record it. Nothing is recorded when every move was equally bad
   (position simply lost).

Applied by: the search excludes known-bad moves at any node whose position
matches a recorded exception board for the current difficulty, so it
"performs the backtrack to try something different." Exceptions persist in
localStorage and are exportable/importable as JSON.
