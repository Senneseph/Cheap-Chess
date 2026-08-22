# Cheap Chess — UCI mapping

UCI (Universal Chess Interface) is the de-facto engine protocol (Stockfish,
Leela Chess Zero, etc.). Supporting it is what lets Cheap Chess "easily enter
a competition with some minor logic changes."

## Run it

```bash
node develop/cheap-chess-uci.mjs
```

Or pipe commands:

```bash
printf 'uci\nisready\nposition startpos moves e2e4 e7e5\ngo depth 4\nquit\n' \
  | node develop/cheap-chess-uci.mjs
```

Any UCI GUI (Arena, Cute Chess, BanksiaGUI) or competition harness can drive
it the same way over stdio.

## Commands

| Command | Behavior |
|---|---|
| `uci` | id + options + `uciok` |
| `isready` | `readyok` |
| `setoption name X value Y` | Difficulty (1–10), Learning (check), PieceValuePawn/Knight/Bishop/Rook/Queen (pawns), CenterControl (pawns/sq), CheckBonus (cp), ThreatBonus (cp), TradeBonus (cp), MateScore (cp), PoolSize (65536–2097152), ClearExceptions (button) |
| `ucinewgame` | reset position, history, pool |
| `position startpos \| fen <fen> [moves ...]` | set up position; illegal moves are rejected with an `info string` |
| `go depth N` | search to depth N (plies) |
| `go movetime N` | search with a wall-clock budget; plays whatever the last fully-completed depth produced |
| `go wtime W btime B winc WI binc BI` | tournament clock: budget = myTime/40 + inc·0.7, clamped 50ms–10s |
| `go infinite` | keep deepening until `stop` (depth 32 cap) |
| `stop` | interrupt (honored within ~4096 nodes); `bestmove` follows |
| `ponder` / `ponderhit` | accepted, no pondering |
| `quit` | exit |
| `d` | FEN + side + check status (extension) |
| `eval` | static evaluation (extension) |
| `perft N` | move-gen validation (extension) |
| `learn list \| clear` | exception table introspection (extension) |

## Output

`info depth N score cp X|mate M nodes N nps N time T pv ...` per completed
depth, then `bestmove <uci>` (or `bestmove 0000` when no move exists).

## Competition notes ("minor logic changes")

- **Learning**: on by default (casual play). Tournaments normally set
  `setoption name Learning value false` so each game is a fresh, deterministic
  engine.
- **Engine profile**: the evaluation knobs (piece values, center control,
  check/threat/trade bonuses, mate score) form a *profile*. Changing any knob
  switches the learner to a separate, per-profile exception cache
  (`info string engine profile <fp>` reports the new namespace) — knowledge
  from other settings is never applied.
- **TradeBonus**: the "likes to trade" personality; set 0 for a more
  material-strict engine.
- **Time**: with `go wtime/btime` the engine self-allocates; `movetime` is the
  hard limit. Normal play (the web app) has no time limit.
- Determinism: same position, difficulty, options, and exception table →
  identical output (useful for test harnesses and reproducible games).
