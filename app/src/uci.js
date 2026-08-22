// uci.js — Universal Chess Interface adapter for the Cheap Chess engine.
//
// UCI is the de-facto standard protocol for chess engines (Stockfish, Leela,
// etc.), which is what lets Cheap Chess enter a competition with only minor
// logic changes. This class is transport-agnostic: feed it lines, read output
// lines. The Node CLI wrapper lives at develop/cheap-chess-uci.mjs; the same
// class could be wired to a socket or an in-page console.
//
// Supported: uci, isready, setoption, ucinewgame, position (startpos|fen +
// moves), go (depth | movetime | wtime/btime/winc/binc | infinite), stop,
// ponder/ponderhit, quit, plus extensions: d (position), eval, perft, learn.

import { CheapGame } from './game.js';
import { CheapLearner } from './learner.js';
import { Searcher } from './search.js';
import { evaluate } from './eval.js';
import { uciName, perft, inCheck, stateToFen } from './board.js';
import { DEFAULT_CONFIG, configFingerprint } from './config.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class CheapChessUCI {
  constructor({ out = console.log } = {}) {
    this.out = (s) => out(s);
    this.quit = false;
    this.config = { ...DEFAULT_CONFIG };
    this.learner = new CheapLearner({ namespace: configFingerprint(this.config) });
    this.searcher = new Searcher({ config: this.config });
    this.game = new CheapGame({ learner: this.learner, searcher: this.searcher, config: this.config });
    this.game.humanColor = 0; // UCI drives both sides directly
    this.options = { Difficulty: 4, Learning: true, PoolSize: 262144, TradeBonus: this.config.tradeBonus, Threads: 1 };
    this.searching = false;
  }

  // Rebuild engine profile-dependent pieces (learner namespace, searcher config).
  _applyConfig() {
    this.searcher.config = { ...this.config };
    const ns = configFingerprint(this.config);
    this.learner = new CheapLearner({ namespace: ns });
    this.learner.enabled = this.options.Learning;
    this.game.learner = this.learner;
    this.game.config = { ...this.config };
    this.out('info string engine profile ' + ns + ' (exceptions cache is per-profile)');
  }

  handle(line) {
    if (typeof line !== 'string') return;
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    switch (cmd) {
      case 'uci':
        this.out('id name CheapChess ' + '0.1.0');
        this.out('id author Cheap Chess Project');
        this.out('option name Difficulty type spin default 4 min 1 max 14');
        this.out('option name Learning type check default true');
        this.out('option name Threads type spin default 1 min 1 max 32');
        this.out('option name PieceValuePawn type spin default 1 min 0 max 9');
        this.out('option name PieceValueKnight type spin default 3 min 0 max 20');
        this.out('option name PieceValueBishop type spin default 3 min 0 max 20');
        this.out('option name PieceValueRook type spin default 5 min 0 max 20');
        this.out('option name PieceValueQueen type spin default 9 min 0 max 50');
        this.out('option name CenterControl type spin default 2 min 0 max 10');
        this.out('option name CheckBonus type spin default 0 min 0 max 200');
        this.out('option name ThreatBonus type spin default 0 min 0 max 200');
        this.out('option name TradeBonus type spin default 12 min 0 max 200');
        this.out('option name MateScore type spin default 1000000 min 10000 max 10000000');
        this.out('option name Quiescence type check default true');
        this.out('option name QuiescenceDepth type spin default 6 min 0 max 16');
        this.out('option name KingSafety type spin default 100 min 0 max 500');
        this.out('option name PoolSize type spin default 262144 min 65536 max 2097152');
        this.out('option name ClearExceptions type button');
        this.out('uciok');
        break;
      case 'isready':
        this.out('readyok');
        break;
      case 'setoption':
        this._setoption(parts.slice(1));
        break;
      case 'ucinewgame':
        this.game.reset();
        this.searcher.newGame();
        this.searching = false;
        break;
      case 'position':
        this._position(parts.slice(1));
        break;
      case 'go':
        return this._go(parts.slice(1));
      case 'stop':
        if (this.searching) this.searcher.stop();
        break;
      case 'ponder':
      case 'ponderhit':
        break; // no pondering in the cheap engine
      case 'quit':
        this.quit = true;
        break;
      case 'd':
        this.out('info string FEN: ' + stateToFen(this.game.state));
        this.out('info string side: ' + (this.game.state.turn === 1 ? 'white' : 'black') + (inCheck(this.game.state) ? ' (check!)' : ''));
        break;
      case 'eval':
        this.out('info string static eval: ' + (evaluate(this.game.state) / 1000).toFixed(2) + ' (pawns, from side to move)');
        break;
      case 'perft':
        this.out('info string perft(' + parts[1] + ') = ' + perft(this.game.state, +parts[1]));
        break;
      case 'learn':
        this._learn(parts.slice(1));
        break;
      default:
        this.out('info string unknown command: ' + cmd);
    }
  }

  _setoption(args) {
    // setoption name <Name> value <Value...>
    const nameIdx = args.indexOf('name');
    const valueIdx = args.indexOf('value');
    if (nameIdx < 0) return;
    const name = valueIdx > nameIdx ? args.slice(nameIdx + 1, valueIdx).join(' ') : args.slice(nameIdx + 1).join(' ');
    const value = valueIdx >= 0 ? args.slice(valueIdx + 1).join(' ') : '';
    switch (name) {
      case 'Difficulty': this.options.Difficulty = clamp(+value || 4, 1, 14); break;
      case 'Learning': {
        const on = value === 'true' || value === '1';
        this.options.Learning = on;
        break;
      }
      case 'Threads': this.options.Threads = clamp(+value || 1, 1, 32); break;
      case 'PieceValuePawn': this.config.pieceValues[1] = clamp(+value, 0, 9); break;
      case 'PieceValueKnight': this.config.pieceValues[2] = clamp(+value, 0, 20); break;
      case 'PieceValueBishop': this.config.pieceValues[3] = clamp(+value, 0, 20); break;
      case 'PieceValueRook': this.config.pieceValues[4] = clamp(+value, 0, 20); break;
      case 'PieceValueQueen': this.config.pieceValues[5] = clamp(+value, 0, 50); break;
      case 'CenterControl': this.config.centerPoints = clamp(+value, 0, 10); break;
      case 'CheckBonus': this.config.checkBonus = clamp(+value, 0, 200); break;
      case 'ThreatBonus': this.config.threatBonus = clamp(+value, 0, 200); break;
      case 'TradeBonus': this.config.tradeBonus = clamp(+value, 0, 200); break;
      case 'MateScore': this.config.mateScore = clamp(+value, 10000, 10000000); break;
      case 'Quiescence': this.config.quiescence = value === 'true' || value === '1'; break;
      case 'QuiescenceDepth': this.config.quiescenceDepth = clamp(+value, 0, 16); break;
      case 'KingSafety': this.config.kingSafetyPoints = clamp(+value, 0, 500); break;
      case 'PoolSize': this.searcher = new Searcher({ poolSize: clamp(+value || 262144, 65536, 2097152), config: this.config }); this.options.PoolSize = this.searcher.pool.cap; break;
      case 'ClearExceptions': this.learner.clear(); this.out('info string cleared exceptions for profile ' + configFingerprint(this.config)); break;
      default: this.out('info string unknown option: ' + name); return;
    }
    // any engine-profile knob changed => fresh, separate exception cache
    if (name !== 'Difficulty' && name !== 'PoolSize' && name !== 'ClearExceptions' && name !== 'Learning' && name !== 'Threads') {
      this._applyConfig();
    } else if (name === 'Learning') {
      this.learner.enabled = this.options.Learning;
    }
  }

  _position(args) {
    // position [startpos | fen <fen...>] [moves <m1> <m2> ...]
    let idx = 0, fen = START_FEN;
    if (args[0] === 'startpos') idx = 1;
    else if (args[0] === 'fen') { fen = args.slice(1, 7).join(' '); idx = 7; }
    else { this.out('info string bad position'); return; }
    this.game.loadFen(fen);
    if (args[idx] === 'moves') {
      for (const mv of args.slice(idx + 1)) {
        const res = this.game.applyUciMove(mv);
        if (!res.ok) { this.out('info string illegal move: ' + mv); break; }
      }
    }
  }

  async _go(args) {
    const g = this.game;
    if (g.isOver()) { this.out('bestmove 0000'); return; }
    let depth = this.options.Difficulty;
    let movetime = 0;
    let wtime = 0, btime = 0, winc = 0, binc = 0;
    let infinite = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === 'depth') depth = +args[++i];
      else if (a === 'movetime') movetime = +args[++i];
      else if (a === 'wtime') wtime = +args[++i];
      else if (a === 'btime') btime = +args[++i];
      else if (a === 'winc') winc = +args[++i];
      else if (a === 'binc') binc = +args[++i];
      else if (a === 'infinite') infinite = true;
    }
    let timeLimit = 0;
    if (movetime) timeLimit = movetime;
    else if (!infinite && (wtime || btime)) {
      const myTime = g.state.turn === 1 ? wtime : btime;
      const inc = g.state.turn === 1 ? winc : binc;
      timeLimit = clamp(Math.floor(myTime / 40) + Math.floor(inc * 0.7), 50, 10000);
    }
    const maxDepth = infinite ? 32 : depth;

    this.searching = true;
    const baseOpts = {
      difficulty: this.options.Difficulty,
      historyKeys: g.historyKeys,
      timeLimitMs: timeLimit,
    };
    const threads = this.options.Threads || 1;
    let res;
    if (threads > 1) {
      // parallel Lazy SMP (nondeterministic by nature — competition engines
      // typically keep Threads=1 for reproducibility)
      const { parallelSearch } = await import('./parallel-search.js');
      res = await parallelSearch({
        state: g.state,
        depth: maxDepth,
        timeLimitMs: timeLimit,
        historyKeys: g.historyKeys,
        difficulty: this.options.Difficulty,
        config: this.config,
        exceptions: this.learner.enabled ? this.learner.exportCompact(this.options.Difficulty) : [],
        workerCount: threads,
      });
      this.out(`info string threads ${res.stats.workers} depth ${res.stats.depth} nodes ${res.stats.nodes}`);
    } else {
      res = this.searcher.search(g.state, maxDepth, {
        ...baseOpts,
        learner: this.learner.enabled ? this.learner : null,
        onIteration: (it) => {
          const M = this.config.mateScore;
          // internal points = 1/1000 pawn; UCI cp = 1/100 pawn => divide by 10
          const cp = Math.round(it.score / 10);
          const scoreStr = Math.abs(it.score) >= M - 1000
            ? 'mate ' + (Math.sign(it.score) < 0 ? '-' : '') + Math.ceil((M - Math.abs(it.score)) / 2)
            : 'cp ' + cp;
          const nps = Math.round(it.nodes / Math.max(1, it.ms / 1000));
          this.out(`info depth ${it.depth} score ${scoreStr} nodes ${it.nodes} nps ${nps} time ${it.ms}${it.poolExhausted ? ' string pool exhausted' : ''}`);
        },
      });
    }
    this.searching = false;
    this.searcher.stopRequested = false;

    if (this.learner.enabled) {
      const ex = this.learner.lookup(this.options.Difficulty, g.state.k1, g.state.k2);
      if (ex) this.out('info string exception board: avoiding ' + [...ex.bad].map((m) => uciName(m)).join(',') + ' preferring ' + uciName(ex.good));
    }
    this.out('bestmove ' + (res.move ? uciName(res.move) : '0000'));
  }

  _learn(args) {
    const cmd = args[0];
    if (cmd === 'clear') { this.learner.clear(); this.out('info string learner cleared'); }
    else if (cmd === 'list') {
      const items = this.learner.list(this.options.Difficulty);
      if (!items.length) { this.out('info string no exceptions for difficulty ' + this.options.Difficulty); return; }
      for (const it of items) {
        this.out(`info string ${it.poskey} | avoid ${it.bad.map((m) => uciName(m)).join(',')} | prefer ${uciName(it.good)} | ${it.why} x${it.times}`);
      }
    } else this.out('info string learn [clear|list]');
  }
}
