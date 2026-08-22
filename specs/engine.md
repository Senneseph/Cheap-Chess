# Cheap Chess — engine architecture

## Layers

```
app/src/
  board.js     rules: mailbox-64 board, legal movegen, FEN, zobrist keys, perft
  eval.js      scoring: material + center control (+ trade-bonus constant)
  search.js    MovePool (fixed node arena) + iterative-deepening negamax
  learner.js   per-difficulty exception table + backtrace logic
  game.js      game controller: position, engine turn, decision log, undo
  san.js       algebraic notation for the UI
  uci.js       UCI adapter (competition interface)
  chess-board.js  <cheap-chess> web component (UI)
  chess-worker.js module worker that runs searches off the main thread
  main.js      app bootstrap + service worker registration
```

## Engine profiles (parameterization)

Everything that changes how the engine plays lives in `app/src/config.js`
(`DEFAULT_CONFIG`, `PRESETS`, `sanitizeConfig`, `configFingerprint`): piece
values, center control, check/threat/trade bonuses, and mate score. The eval
(`eval.js`) and search (`search.js`) read from a config object; a `Searcher`
is constructed with one.

The learner's storage key is namespaced by `configFingerprint(config)`, so an
exception recorded under profile A is never consulted under profile B — the
cache must match the settings before it is used, exactly as specified.
Difficulty remains a per-record dimension inside the namespace. Changing a
profile means a fresh learner (UI: New Game screen; UCI: any profile
`setoption` reports the new namespace via `info string engine profile <fp>`).

## The fixed-size move tree

The user's design: "there's only so many moves you can make for a given board,
so this can be a reusable heap of memory with a fixed size. Each new turn, the
system frees the memory that no longer applies (branches for moves that weren't
played) and searches one more level."

`MovePool` is a fixed arena of nodes (parallel typed arrays, free list —
no unbounded allocation, no GC churn). A node holds its parent, packed move,
sibling/first-child links, depth, and score. The search allocates from the
free list; `freeSubtree` returns a branch; `advance(move)` retargets the root
to the played line and frees everything else; `newGame`/undo frees the whole
tree. If the arena fills mid-search, expansion stops and the best-so-far is
returned (flagged `poolExhausted` in the stats).

Each engine turn re-runs iterative deepening from 1..difficulty over the
reused arena, so the tree from the start of the game grows one ply deeper
every turn ("searches one more level"), and the pool is genuinely reused and
bounded.

## Why the trade bonus is a root-level bonus

A "prefers to trade" personality cannot be a plain eval term: any positional
feature added to *both* sides' leaf evals flips sign through the negamax
negation chain, making the engine trade at even depths and refuse at odd
depths (or worse, favor the side that moves last). The clean formulation is a
small bonus added to capture moves at the root of the engine's own search —
the actual decision point. Material loss still dominates, so only
risk-free/equal exchanges are nudged.

## Determinism

Same position + same difficulty + same exception table + fresh `Searcher`
⇒ same move (stable ordering, fixed zobrist seed). The learner depends on this
for reproducible replays.

## Draw handling in search

A node returns 0 (draw) when the position has occurred twice before along
(game history + search path) — i.e., the current visit is the third — or when
the half-move clock reaches 100. This gives a losing engine the standard
"take the draw" behavior without extra cost.

## Learner data flow

```
game._finishEngineMove → log.push({fen, poskey, difficulty, chosen, score,
                                    rootScores, histLen})
human reply refutes    → game._hindsight(prevEntry)   (re-analyze, record)
game loss              → game.learnFromLoss()         (backtrace → record)
search                 → learner.lookup(difficulty, k1, k2) → exclude bad moves
UI                     → learner.count/clear/export/import
```

Two mechanisms create lessons, and both use **hindsight**: a naive backtrace
can never fire, because the chosen move was the max of its own rootScores at
search time — the failure only becomes visible later. So after a loss (or when
the human's reply refutes the previous move), the game RE-SEARCHES the past
decision position at difficulty + 2 and records the first decision where a
clearly better alternative existed (improvement ≥ 100 points) — at the ORIGINAL
difficulty. Walking back from the loss, it stops at the first fixable board
("the next board that doesn't always lead to an equivalent bad outcome").

**Symmetry fan-out**: every lesson is stored under 4 transforms — identity,
left-right mirror, color-invert, and 180° rotation — because the engine's
evaluation is symmetric under all of them. That multiplies the effective
database 4x for free (each transform's bad/good moves are transformed too).
Cap: 2000 records per profile, evicted least-recently-used (lookup hits refresh
usage). Exception thresholds (`learner.js`): blunder ≤ −200 points; improvement
≥ 100 points.

**Critical consistency note**: the learner matches positions by 64-bit zobrist
keys, so the incremental key path (applyMove) and the from-scratch paths
(startState/fenToState/transformPosition) MUST agree — including the castling
rights, the (normalized) en-passant square, and the convention that the turn
key is present iff white is to move. A mismatch here silently breaks every
lookup (see tests/keys.test.mjs).

## Performance notes

- With the transposition table: depth 4 ≈ 50 ms, depth 5 ≈ 100–200 ms,
  depth 6 ≈ 0.5–1.5 s in middlegame positions (the default pool tier handles
  these; deeper difficulties use bigger pools and may degrade gracefully to
  best-so-far when the fixed memory is exhausted — by design, per the
  fixed-memory brief).
- Self-play shows depth 4 vs depth 6 is roughly even: at these depths the
  EVALUATION is the bottleneck (no king safety, no pawn structure, no
  quiescence), not the search. Expect diminishing returns from depth alone
  until the eval is enriched.
- If you want stronger play per node: add captures-only quiescence (biggest
  single win), then king-safety/pawn-structure terms, then null-move
  pruning/LMR. The pool/TT/API don't preclude any of them.

## Depth, memory, and parallelism

- **Difficulty = plies, 1–14** (14 = 7 full turns). Normal play self-limits each
  move at ~20s; competition uses the UCI clock.
- **Memory**: the node pool grows lazily to a tiered cap per difficulty
  (64k → 40M nodes ≈ 1.3 MB → 880 MB), plus a transposition table capped at
  1M entries (~18 MB). The pool is the binding constraint at high depth — when
  it fills, the search degrades to best-so-far (flagged in the stats).
- **Parallelism — parallel root-move splitting** (`parallel-search.js`): the
  orchestrator orders the root moves (MVV-LVA) and round-robins them into N
  slices; each worker runs the FULL sequential search on its slice (Web
  Workers in the app, worker_threads in the UCI CLI, `Threads` option). Each
  slice is exact (same code path as the sequential engine), the merged
  rootScores cover every root move for the learner, and the run is
  deterministic for a fixed worker count.
  **Honest scaling**: alpha-beta is NOT embarrassingly parallel — pruning
  depends on search order. The best move's subtree dominates its slice, so
  expect ~1.4–2x wall speedup (≈ +1 ply within a 20s budget), not Nx. Beyond
  ~8 workers it's redundancy, not speed. (Lazy SMP / shared-TT schemes do
  better but need shared memory the browser doesn't provide.)
- **Depth reality**: 14 plies needs ~10¹¹ nodes — days at ~2M nps — so within
  20s the engine reaches ~depth 7 single-threaded, ~7–8 with the cores.
  No alpha-beta engine reaches 14 plies in 20s.

## Quiescence — the "last minute check" (implemented)

Fixed-depth search used to evaluate the board at whatever position the depth
limit landed on — which could be mid-tactic (a piece just captured, a knight
attacking one, etc.), so the eval reported a nonsense number for a board still
"in motion." Quiescence fixes that: when the search reaches its depth limit, if
captures remain (or the side to move is in check), the search keeps going
through the capture/evasion sequence until the position is quiet, then stands
pat (if doing nothing already beats beta, it stops immediately). Leaves are
always settled boards.

Details:

- Captures-only resolution with a dedicated fast generator
  (`generateCaptures` in board.js); in-check positions search every evasion.
- "Crude SEE": capture chains that hand over more than they take (attacker
  worth more than victim) are skipped, so queen-chases-pawn blowups never
  happen and the q-tree stays small.
- Repetition and 50-move draws apply inside quiescence, so perpetual checks
  resolve to a draw instead of a line.
- Allocates NO pool nodes — the fixed-size arena is untouched.
- Tuneable: `quiescence` (on/off) and `quiescenceDepth` (default 6) are engine
  profile knobs (New Game screen / UCI `Quiescence` / `QuiescenceDepth`), so
  the learner cache is keyed per setting.

Measured effect: quiescence is worth roughly **two plies of fixed-depth
search** — self-play, depth-4-with-quiescence vs depth-6-without finished 3-3.
It costs ~1 ply of reachable depth within a time budget (q nodes consume the
budget), which is a very good trade. Depth timing with q on: d4 ≈ 300ms,
d5 ≈ 0.7s, d6 ≈ 5-7s (within the 20s self-limit; 8 parallel workers restore
~+1-2 plies).
