# Cheap Chess — instruction evaluation

You asked: *"evaluate these instructions and let me know if I've left anything
out?"* Here is the honest gap list. Every gap below is either resolved by a
documented assumption in the code, or flagged as a decision you should confirm.

## Gaps in the original brief

1. **Depth units — plies vs full moves.** "4 moves ahead" could mean 4
   half-moves (plies) or 4 full moves (8 plies). 8 plies is ~30⁸ ≈ 10¹² nodes —
   far too slow for a browser. **Resolved:** depth is measured in plies
   (half-moves); difficulty 4 is the default. 4 plies ≈ 10–50ms. This is also
   the UCI convention (`go depth N` = plies).

2. **Castling.** You said you don't care about it, but "standard chess rules"
   and "easily enter a competition" require it — a competition engine that can't
   castle is trivially exploitable. **Resolved:** castling is implemented
   correctly (rights, empty squares, not through/into check). It costs ~40
   lines. If you genuinely want it gone, flip `CR_*` off in `board.js`.

3. **En passant.** Not mentioned; it is standard chess and a classic perft
   trap. **Resolved:** implemented, and validated by the perft suite.

4. **Stalemate + draw rules.** Not mentioned. Without stalemate the engine
   can't distinguish "king = game" (mate) from "no legal moves" (draw), and it
   would walk into losing endgames instead of taking a draw. **Resolved:**
   stalemate, 50-move, threefold repetition, and insufficient material are all
   implemented at game level; repetition/50-move also work inside the search so
   a losing engine takes the draw.

5. **Time controls.** Not mentioned, but a competition engine needs a clock.
   **Resolved:** the UCI adapter supports `go movetime N` and
   `go wtime X btime Y winc Z binc Z` — the search deepens until the budget is
   spent and plays "whatever it got" from the last *fully-completed* depth.
   Normal play in the app has no time limit (as you specified).

6. **What counts as "fails" for the learner.** You said "if a path it chose
   fails." **Resolved:** failure = the engine loses the game (checkmate or
   resignation), plus a fast path when the human's reply refutes the engine's
   last move. Both trigger **hindsight analysis**: the game re-searches the
   past decision at difficulty + 2 and records the first fixable board. (A
   naive backtrace is provably dead — the chosen move was the max of its own
   rootScores — a real bug found by simulation and fixed.)

7. **"The next board that doesn't always lead to an equivalent bad outcome."**
   **Resolved:** the backtrace walks the decision log from the loss; at each
   decision it re-searches with deeper vision (difficulty + 2) and records the
   first board where an alternative scored at least 100 points better — at the
   ORIGINAL difficulty. If no alternative was clearly better (all moves lose
   equally), nothing is recorded. Lessons also fan out across the 4 symmetry
   transforms (mirror / color-invert / rotate), multiplying the database 4x.

8. **Opponent model.** "Safe route / doesn't lose" assumes the opponent plays
   to maximize their own score (minimax). **Resolved:** negamax — the engine
   assumes the opponent always plays the reply that's worst for the engine.
   If you ever want a "greedy, shallow" opponent instead, that's a different
   search mode (not built).

9. **Center-control scoring value.** You thought 2, then settled the model:
   **10 points per potential move** a piece can make into any of the four
   center squares (empty, enemy-occupied, or friendly-occupied all count),
   with pawn = 1000 and N/B/R/Q = 3000/5000/9000. The whole center stays
   worth less than a single pawn in practice. **Check value**: you never
   settled it — defaulted to 50 points (0.05 pawns), a gentle nudge toward
   checking when lines are otherwise equal; `threatBonus` is 30 and
   `tradeBonus` 120 on the same scale. All of it stays adjustable in the
   New Game screen / UCI options.

10. **King safety.** Was flagged as the biggest eval hole (the king was only
    "game" — checkmate — so the engine never castled and marched kings into
    the center). **Now implemented** as `kingSafetyPoints`: pawn shield in
    front of the king, open-file penalties, a castled bonus (it actually
    castles now), and a wandering-king penalty (the old king-march is gone).
    Board reads only, so quiescence stays fast (~17% at depth 6). Still a
    profile knob, so the learner cache keys on it.

11. **Horizon effect / quiescence.** A fixed-depth leaf eval hangs pieces one
    ply past the horizon. You recalled adding "a last minute check to avoid
    bad situations" to your original design — that is exactly quiescence, and
    it is now implemented (captures + check evasions resolved at the depth
    limit, stand-pat cutoff, crude SEE pruning, no pool-node usage). Self-play
    shows it is worth ~2 plies of fixed depth (d4-with-q vs d6-without-q:
    3-3). It is a profile knob (`Quiescence`, `QuiescenceDepth`), so the
    learner cache keys on it like everything else.

12. **Competition protocol.** You said "follow a standard that would allow it
    to easily enter a competition." **Resolved:** UCI (Universal Chess
    Interface) — the protocol used by Stockfish, Leela, etc. See
    `develop/cheap-chess-uci.mjs` and `specs/uci.md`. The "minor logic
    changes" are UCI options: `Learning` (on by default for casual play,
    tournaments usually turn it off), `Difficulty`, `TradeBonus`, `PoolSize`,
    `ClearExceptions`.

13. **Fixed-size heap.** You said "like a re-usable heap of memory that might
    have a fixed size." **Resolved:** a fixed node pool (default 262,144 nodes
    ≈ 7 MB, `PoolSize` option). Branches not played are freed each turn
    (`pool.advance`); if the pool fills mid-search the engine degrades
    gracefully (best-so-far, flagged in the stats).

14. **"Searches one more level" each turn.** **Resolved** as: the pool
    persists across turns, the played line is kept, everything else is freed,
    and each engine turn re-searches to the difficulty cap — so the tree from
    the game's start grows one ply deeper every turn. (Alpha-beta re-searches
    internally; the memory semantics are exactly as you described.)

15. **Promotion.** Confirmed: engine always promotes to Queen; the human gets
    a chooser with Queen highlighted.

16. **"It likes to trade."** (added later) — implemented as a small
    root-level bonus (+12cp, configurable via the TradeBonus control) for
    captures whose search line is not losing.
    This is the only way to express a trading personality without breaking
    minimax (a leaf-eval version would make the engine trade at even depths
    but refuse at odd ones). It is a tiebreaker: a capture that genuinely
    loses material still loses to any quiet alternative. `CheckBonus` and
    `ThreatBonus` (both default 0) are the same kind of tunable eval terms:
    +cp for having the opponent's king in check, and +cp per enemy piece you
    attack.

17. **Starting position / FEN / who moves first.** Not mentioned.
    **Resolved:** standard start position; the UI lets you play White or
    Black; UCI `position startpos|fen ... moves ...` handles everything else.

18. **Persistence.** Not mentioned. **Resolved:** exceptions live in
    localStorage (per difficulty, exportable/importable JSON), as do settings
    and the in-progress game.

## Ambiguities resolved by assumption (worth a skim)

- **Depth parity & eval noise:** scores oscillate ±400 between odd/even
  depths early on (center control is big). Normal for a cheap engine;
  higher difficulty converges.
- **"Threaten with the next move"** is pseudo-legal (pins ignored) — cheap and
  matches your phrasing.
- **50-move rule** uses the standard 100 half-move clock.
- **Resignation:** the human can resign; the engine never resigns (it plays
  on, per "king = game").
- **Undo** undoes the engine reply too (2 plies) and frees the pool (a fresh
  search rebuilds the tree).
