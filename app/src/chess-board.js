// chess-board.js — <cheap-chess> web component.
// A self-contained playable board. The New Game screen lets you choose your
// side AND the engine's personality: every scoring knob (piece values, center
// control, check/threat/trade bonuses, mate score) plus the search depth and
// learning toggle. The learner's exception cache is namespaced by the engine
// profile fingerprint, so knowledge learned under one set of settings is never
// applied under another. Searches run in a Web Worker when available.

import {
  WHITE, BLACK, generateLegal, mvFrom, mvTo, mvPromo,
  sqFile, sqRank, squareName, applyMove, inCheck,
} from './board.js';
import { CheapGame } from './game.js';
import { CheapLearner } from './learner.js';
import { san } from './san.js';
import { DEFAULT_CONFIG, PRESETS, configFingerprint, sanitizeConfig } from './config.js';
import { poolSizeForDepth } from './search.js';
import { parallelSearch } from './parallel-search.js';

const GLYPHS = { 1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚' };
const DIFF_MIN = 1, DIFF_MAX = 14, DIFF_DEFAULT = 4;
const MOVE_TIME_MS = 20000; // normal play: self-limit per move ("7 turns unless it runs >20s")

const SETTINGS_KEY = 'cheap-chess.settings.v1';
const GAME_KEY = 'cheap-chess.game.v1';

const STYLE = `
:host { --cc-accent:#0b6bcb; --cc-bg:#12161c; --cc-panel:#1a212b; --cc-text:#d7e0ea;
  --cc-dim:#8b98a8; --cc-light:#dfe7ee; --cc-dark:#9fb2c4; --cc-hi:#ffd54f; --cc-check:#e05252;
  font-family: system-ui, sans-serif; color: var(--cc-text); display:block; }
* { box-sizing: border-box; }
.cc-layout { display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start; background:var(--cc-bg); padding:16px; border-radius:12px; }
.cc-board-col { flex:0 0 auto; }
.cc-status { min-height:1.6em; font-weight:600; margin-bottom:8px; color:var(--cc-dim); }
.cc-status.thinking { color:var(--cc-hi); }
.board-wrap { position:relative; }
.cc-board { display:grid; grid-template-columns:repeat(8, minmax(0, 1fr)); width:min(78vw, 480px);
  aspect-ratio:1; border:2px solid #2a3442; border-radius:4px; overflow:hidden; }
button.sq { border:0; padding:0; margin:0; background:transparent; cursor:pointer; position:relative;
  display:flex; align-items:center; justify-content:center; font-size:clamp(18px, 6vw, 38px); line-height:1; }
button.sq.light { background:var(--cc-light); } button.sq.dark { background:var(--cc-dark); }
button.sq.selected { outline:3px solid var(--cc-hi); outline-offset:-3px; z-index:2; }
button.sq.last { background:#ffd54f66; }
button.sq.check { background:radial-gradient(circle, #e0525299 0%, transparent 70%); }
button.sq .dot { position:absolute; width:26%; height:26%; border-radius:50%; background:#00000055; pointer-events:none; }
button.sq .dot.capture { background:none; border:3px solid #00000055; width:80%; height:80%; }
.pc { pointer-events:none; }
.pc.w { color:#f7f5ee; text-shadow:0 1px 2px #00000099, 0 0 1px #000; }
.pc.b { color:#1c2128; text-shadow:0 1px 2px #ffffff88, 0 0 1px #fff; }
.coord { position:absolute; font-size:10px; color:#00000066; font-weight:700; }
.coord.rank { left:3px; top:calc(var(--i) * 12.5% + 2px); }
.coord.file { bottom:2px; left:calc(var(--i) * 12.5% + 4px); }
.cc-eval { display:flex; align-items:center; gap:8px; margin-top:8px; }
.eval-bar { width:12px; height:56px; border-radius:6px; background:linear-gradient(to top, #1c2128 50%, #e8e3d5 50%); overflow:hidden; position:relative; }
.eval-fill { position:absolute; bottom:0; left:0; right:0; background:#f7f5ee; transition:height .3s; }
.eval-text { font-variant-numeric: tabular-nums; color:var(--cc-dim); font-size:13px; }
.pv-line { margin-top:4px; font-size:12px; color:var(--cc-dim); word-break:break-all; }
.cc-panel { flex:1 1 240px; min-width:230px; display:flex; flex-direction:column; gap:10px; }
.cc-panel h3 { margin:6px 0 2px; font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--cc-dim); }
.cc-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.cc-row label { font-size:13px; color:var(--cc-text); }
select, button.btn, input[type=range] { font:inherit; }
button.btn { background:#243043; color:var(--cc-text); border:1px solid #33445c; border-radius:6px; padding:5px 10px; cursor:pointer; }
button.btn:hover { background:#2c3d55; }
button.btn.primary { background:var(--cc-accent); border-color:var(--cc-accent); color:#fff; }
button.btn.danger { color:#ff9d9d; }
button.btn.active { outline:2px solid var(--cc-hi); }
button.btn:disabled { opacity:.4; cursor:not-allowed; }
select { background:#243043; color:var(--cc-text); border:1px solid #33445c; border-radius:6px; padding:4px 6px; }
input[type=range] { width:110px; accent-color:var(--cc-accent); }
input[type=checkbox] { accent-color:var(--cc-accent); }
input[type=number] { background:#0e1217; color:var(--cc-text); border:1px solid #33445c; border-radius:6px; width:64px; padding:3px 6px; font:inherit; }
.diff-note { font-size:11px; color:var(--cc-dim); }
.profile-note { font-size:11px; color:var(--cc-dim); word-break:break-all; }
.movelist { max-height:150px; overflow:auto; font-size:13px; line-height:1.5; background:#0e1217; border-radius:6px; padding:6px 8px; border:1px solid #232e3c; }
.movelist .n { color:var(--cc-dim); margin-right:4px; }
.stats { font-size:11px; color:var(--cc-dim); line-height:1.5; }
.banner { padding:8px 10px; border-radius:6px; font-weight:700; margin-top:8px; text-align:center; }
.banner.win { background:#1d3a2a; color:#8ef0b4; } .banner.loss { background:#3a1d1d; color:#ff9d9d; }
.banner.draw { background:#33302a; color:#ffd98a; }
.toast { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:#1d2b3f; border:1px solid #0b6bcb;
  color:var(--cc-text); padding:8px 14px; border-radius:8px; font-size:13px; box-shadow:0 4px 14px #0008;
  opacity:0; transition:opacity .25s; pointer-events:none; z-index:9999; }
.toast.show { opacity:1; }
.promo-overlay { position:absolute; inset:0; background:#000a; display:flex; align-items:center; justify-content:center; gap:8px; z-index:5; }
.promo-overlay button { font-size:34px; background:#243043; color:var(--cc-text); border:1px solid #33445c; border-radius:8px; padding:8px 10px; cursor:pointer; }
.promo-overlay button:hover { background:#0b6bcb; }
.promo-overlay .hint { position:absolute; bottom:12px; font-size:12px; color:var(--cc-dim); }
.newgame-overlay { position:fixed; inset:0; background:#000b; display:flex; align-items:center; justify-content:center; z-index:100; padding:16px; }
.ng-card { background:#151c25; border:1px solid #2a3442; border-radius:12px; width:min(92vw, 520px); max-height:90vh; display:flex; flex-direction:column; }
.ng-card h3 { margin:14px 16px 8px; }
.ng-scroll { overflow:auto; padding:4px 16px; display:flex; flex-direction:column; gap:9px; }
.ng-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; }
.ng-row > label { min-width:130px; color:var(--cc-dim); }
.ng-row .ng-pv-wrap { display:flex; gap:6px; flex-wrap:wrap; }
.ng-row .ng-pv-wrap span { display:flex; align-items:center; gap:4px; font-size:12px; color:var(--cc-dim); }
.ng-row input[type=number] { width:60px; }
.ng-seg { display:flex; gap:6px; }
.ng-actions { display:flex; gap:8px; padding:12px 16px; border-top:1px solid #232e3c; justify-content:flex-end; }
.ng-note { font-size:11px; color:var(--cc-dim); min-height:1.2em; }
.hidden { display:none !important; }
`;

const TEMPLATE = `
<style>${STYLE}</style>
<div class="cc-layout">
  <div class="cc-board-col">
    <div class="cc-status"></div>
    <div class="board-wrap">
      <div class="cc-board" role="grid" aria-label="chess board"></div>
      <div class="promo-overlay hidden"></div>
    </div>
    <div class="cc-eval">
      <div class="eval-bar"><div class="eval-fill"></div></div>
      <div class="eval-text"></div>
    </div>
    <div class="pv-line"></div>
    <div class="banner hidden"></div>
  </div>
  <div class="cc-panel">
    <h3>Game</h3>
    <div class="cc-row">
      <button class="btn primary new-game">New Game…</button>
      <button class="btn undo">Undo</button>
      <button class="btn danger resign">Resign</button>
    </div>
    <h3>Difficulty (search depth)</h3>
    <div class="cc-row">
      <input type="range" min="1" max="14" value="${DIFF_DEFAULT}" aria-label="difficulty">
      <label class="diff-note">depth <b class="diff-val">${DIFF_DEFAULT}</b> plies · 14 = 7 turns · self-limits ~20s</label>
    </div>
    <h3>Learning</h3>
    <div class="cc-row">
      <input type="checkbox" class="learning" checked><label>exceptions on</label>
      <span class="diff-note ex-count"></span>
    </div>
    <div class="cc-row">
      <button class="btn ex-clear">Clear</button>
      <button class="btn ex-export">Export</button>
      <button class="btn ex-import">Import</button>
      <input type="file" class="ex-file hidden" accept=".json,application/json">
    </div>
    <div class="profile-note"></div>
    <h3>Moves</h3>
    <div class="movelist"></div>
    <h3>Search</h3>
    <div class="stats"></div>
  </div>
</div>
<div class="newgame-overlay hidden">
  <div class="ng-card">
    <h3>New Game — engine personality</h3>
    <div class="ng-scroll">
      <div class="ng-row">
        <label>You play</label>
        <div class="ng-seg">
          <button class="btn ng-side active" data-side="white">White</button>
          <button class="btn ng-side" data-side="black">Black</button>
        </div>
      </div>
      <div class="ng-row">
        <label>Difficulty (plies)</label>
        <input type="range" class="ng-diff" min="1" max="14" value="4">
        <b class="ng-diff-val">4</b>
        <span class="diff-note">14 = 7 turns · ~20s cap</span>
      </div>
      <div class="ng-row">
        <label>Piece values (pawns)</label>
        <div class="ng-pv-wrap">
          <span>P <input type="number" class="ng-pv" data-p="1" min="0" max="9" step="1" value="1"></span>
          <span>N <input type="number" class="ng-pv" data-p="2" min="0" max="20" step="1" value="3"></span>
          <span>B <input type="number" class="ng-pv" data-p="3" min="0" max="20" step="1" value="3"></span>
          <span>R <input type="number" class="ng-pv" data-p="4" min="0" max="20" step="1" value="5"></span>
          <span>Q <input type="number" class="ng-pv" data-p="5" min="0" max="50" step="1" value="9"></span>
        </div>
      </div>
      <div class="ng-row"><label>Center control (pts/move)</label><input type="number" class="ng-center" min="0" max="100" step="1" value="10"></div>
      <div class="ng-row"><label>Check bonus (pts)</label><input type="number" class="ng-check" min="0" max="500" step="5" value="50"></div>
      <div class="ng-row"><label>Threat bonus (pts)</label><input type="number" class="ng-threat" min="0" max="500" step="5" value="30"></div>
      <div class="ng-row"><label>Trade bonus (pts)</label><input type="number" class="ng-trade" min="0" max="500" step="5" value="120"></div>
      <div class="ng-row"><label>King safety (pts)</label><input type="number" class="ng-king" min="0" max="500" step="5" value="100"></div>
      <div class="ng-row"><label>Mate score (pts)</label><input type="number" class="ng-mate" min="10000" max="10000000" step="10000" value="1000000"></div>
      <div class="ng-row">
        <label>Learning</label>
        <input type="checkbox" class="ng-learning" checked>
        <span class="diff-note">cache is per-profile</span>
      </div>
      <div class="ng-row">
        <label>Presets</label>
        <button class="btn ng-preset" data-preset="Classic">Classic</button>
        <button class="btn ng-preset" data-preset="Trader">Trader</button>
        <button class="btn ng-preset" data-preset="Center">Center</button>
        <button class="btn ng-preset" data-preset="Materialist">Materialist</button>
      </div>
      <div class="ng-note"></div>
    </div>
    <div class="ng-actions">
      <button class="btn ng-defaults">Defaults</button>
      <button class="btn ng-cancel">Cancel</button>
      <button class="btn primary ng-start">Start Game</button>
    </div>
  </div>
</div>
<div class="toast hidden"></div>
`;

export class CheapChessBoard extends HTMLElement {
  static observedAttributes = ['difficulty', 'color', 'learning'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = TEMPLATE;
    this._els = {
      board: this.shadowRoot.querySelector('.cc-board'),
      status: this.shadowRoot.querySelector('.cc-status'),
      evalBar: this.shadowRoot.querySelector('.eval-bar'),
      evalFill: this.shadowRoot.querySelector('.eval-fill'),
      evalText: this.shadowRoot.querySelector('.eval-text'),
      pv: this.shadowRoot.querySelector('.pv-line'),
      banner: this.shadowRoot.querySelector('.banner'),
      diff: this.shadowRoot.querySelector('.cc-panel input[type=range]'),
      diffVal: this.shadowRoot.querySelector('.diff-val'),
      newGame: this.shadowRoot.querySelector('.new-game'),
      undo: this.shadowRoot.querySelector('.undo'),
      resign: this.shadowRoot.querySelector('.resign'),
      learning: this.shadowRoot.querySelector('.learning'),
      exCount: this.shadowRoot.querySelector('.ex-count'),
      exClear: this.shadowRoot.querySelector('.ex-clear'),
      exExport: this.shadowRoot.querySelector('.ex-export'),
      exImport: this.shadowRoot.querySelector('.ex-import'),
      exFile: this.shadowRoot.querySelector('.ex-file'),
      movelist: this.shadowRoot.querySelector('.movelist'),
      stats: this.shadowRoot.querySelector('.stats'),
      promo: this.shadowRoot.querySelector('.promo-overlay'),
      toast: this.shadowRoot.querySelector('.toast'),
      profile: this.shadowRoot.querySelector('.profile-note'),
      overlay: this.shadowRoot.querySelector('.newgame-overlay'),
      ngSide: [...this.shadowRoot.querySelectorAll('.ng-side')],
      ngDiff: this.shadowRoot.querySelector('.ng-diff'),
      ngDiffVal: this.shadowRoot.querySelector('.ng-diff-val'),
      ngPv: [...this.shadowRoot.querySelectorAll('.ng-pv')],
      ngCenter: this.shadowRoot.querySelector('.ng-center'),
      ngCheck: this.shadowRoot.querySelector('.ng-check'),
      ngThreat: this.shadowRoot.querySelector('.ng-threat'),
      ngTrade: this.shadowRoot.querySelector('.ng-trade'),
      ngKing: this.shadowRoot.querySelector('.ng-king'),
      ngMate: this.shadowRoot.querySelector('.ng-mate'),
      ngLearning: this.shadowRoot.querySelector('.ng-learning'),
      ngNote: this.shadowRoot.querySelector('.ng-note'),
      ngStart: this.shadowRoot.querySelector('.ng-start'),
      ngCancel: this.shadowRoot.querySelector('.ng-cancel'),
      ngDefaults: this.shadowRoot.querySelector('.ng-defaults'),
      ngPresets: [...this.shadowRoot.querySelectorAll('.ng-preset')],
    };
    this._worker = null;
    this._epoch = 0;
    this._msgId = 0;
    this._selected = -1;
    this._cursor = -1;
    this._pendingPromo = null;
    this._thinking = false;
    this._init();
  }

  // ---- public API ---------------------------------------------------------

  get difficulty() { return parseInt(this.getAttribute('difficulty')) || DIFF_DEFAULT; }
  set difficulty(v) { this.setAttribute('difficulty', String(v)); }
  get learning() { return this.getAttribute('learning') !== 'false'; }
  set learning(v) { this.setAttribute('learning', String(v)); }
  get side() { return (this.getAttribute('color') || 'white') === 'white' ? 'white' : 'black'; }
  set side(v) { this.setAttribute('color', v); }
  get profile() { return this._profileFp; }
  get config() { return this._config; }

  newGame() { this._openNewGame(); }
  undoMove() { this._doUndo(); }
  resignGame() { this._doResign(); }

  connectedCallback() { this._wire(); this._restore(); }
  attributeChangedCallback(name, _old, value) {
    if (name === 'difficulty' && this.game) {
      const d = Math.max(DIFF_MIN, Math.min(DIFF_MAX, parseInt(value) || DIFF_DEFAULT));
      this.game.setSearchDepth(d);
      this._els.diff.value = String(d);
      this._els.diffVal.textContent = d;
      this._saveSettings();
      this._render();
    }
    if (name === 'color' && this.game) {
      this.game.humanColor = value === 'black' ? BLACK : WHITE;
      this._saveSettings();
      this._render();
      this._maybeEngineTurn();
    }
    if (name === 'learning') {
      if (this.game) { this.game.learner.enabled = this.getAttribute('learning') !== 'false'; this._els.learning.checked = this.game.learner.enabled; }
      this._saveSettings();
    }
  }

  // ---- engine profile + game construction ---------------------------------

  // Rebuild the learner (namespaced by the profile fingerprint) and the game.
  _buildGame(cfg, side, learning, difficulty) {
    this._config = sanitizeConfig(cfg);
    const fp = configFingerprint(this._config);
    const changed = fp !== this._profileFp;
    this._profileFp = fp;
    this.learner = new CheapLearner({ namespace: fp });
    this.learner.enabled = learning !== false;
    this.game = new CheapGame({ difficulty: difficulty || this.difficulty, learner: this.learner, config: this._config, poolSize: poolSizeForDepth(difficulty || this.difficulty), timeLimitMs: MOVE_TIME_MS });
    this.game.humanColor = side === 'black' ? BLACK : WHITE;
    this._epoch++;
    this._thinking = false;
    this._selected = -1;
    this._pendingPromo = null;
    this._cursor = -1;
    return changed;
  }

  _init() {
    this._buildGame(DEFAULT_CONFIG, this.side, this.learning, this.difficulty);
    try {
      if (typeof Worker !== 'undefined' && location.protocol.startsWith('http')) {
        this._worker = new Worker(new URL('./chess-worker.js', import.meta.url), { type: 'module' });
        this._worker.addEventListener('message', (e) => this._onWorkerMessage(e.data));
        this._worker.addEventListener('error', () => this._workerFailed());
      }
    } catch { this._worker = null; }
  }

  // ---- wiring --------------------------------------------------------------

  _wire() {
    const els = this._els;
    els.diff.addEventListener('input', () => { this.difficulty = els.diff.value; });
    els.newGame.addEventListener('click', () => this._openNewGame());
    els.undo.addEventListener('click', () => this._doUndo());
    els.resign.addEventListener('click', () => this._doResign());
    els.learning.addEventListener('change', () => { this.learning = els.learning.checked; });
    els.exClear.addEventListener('click', () => {
      this.game.learner.clear(this.game.difficulty);
      this._toast('exception table cleared for this profile @ depth ' + this.game.difficulty);
      this._render();
    });
    els.exExport.addEventListener('click', () => this._exportExceptions());
    els.exImport.addEventListener('click', () => els.exFile.click());
    els.exFile.addEventListener('change', () => this._importExceptions(els.exFile.files[0]));
    els.board.addEventListener('click', (e) => {
      const sq = e.target.closest('button.sq');
      if (sq) this._onSquareClick(+sq.dataset.sq);
    });
    this.shadowRoot.addEventListener('keydown', (e) => this._onKey(e));
    this._els.board.tabIndex = 0;

    // new game modal
    els.ngSide.forEach((b) => b.addEventListener('click', () => {
      els.ngSide.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    }));
    els.ngDiff.addEventListener('input', () => { els.ngDiffVal.textContent = els.ngDiff.value; });
    els.ngPresets.forEach((b) => b.addEventListener('click', () => this._applyPreset(b.dataset.preset)));
    els.ngDefaults.addEventListener('click', () => this._applyPreset('Classic'));
    els.ngStart.addEventListener('click', () => this._startFromModal());
    els.ngCancel.addEventListener('click', () => this._closeNewGame());
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) this._closeNewGame(); });
  }

  // ---- new game modal ------------------------------------------------------

  _openNewGame() {
    this._populateNg();
    this._els.overlay.classList.remove('hidden');
    this._els.ngNote.textContent = '';
  }

  _closeNewGame() { this._els.overlay.classList.add('hidden'); }

  _applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    this._populateNg(p);
    this._els.ngNote.textContent = name + ' preset — change anything you like';
  }

  _populateNg(cfg = this._config) {
    const els = this._els;
    const side = this.game.humanColor === BLACK ? 'black' : 'white';
    els.ngSide.forEach((b) => b.classList.toggle('active', b.dataset.side === side));
    els.ngDiff.value = String(this.game.difficulty);
    els.ngDiffVal.textContent = this.game.difficulty;
    els.ngPv.forEach((i) => { i.value = String(cfg.pieceValues[+i.dataset.p] ?? 0); });
    els.ngCenter.value = String(cfg.centerPoints);
    els.ngCheck.value = String(cfg.checkBonus);
    els.ngThreat.value = String(cfg.threatBonus);
    els.ngTrade.value = String(cfg.tradeBonus);
    els.ngKing.value = String(cfg.kingSafetyPoints);
    els.ngMate.value = String(cfg.mateScore);
    els.ngLearning.checked = this.learning;
  }

  _readNgConfig() {
    const els = this._els;
    const pv = [0, 0, 0, 0, 0, 0, 0];
    for (const i of els.ngPv) pv[+i.dataset.p] = parseFloat(i.value) || 0;
    return {
      pieceValues: pv,
      centerPoints: parseFloat(els.ngCenter.value) || 0,
      checkBonus: parseFloat(els.ngCheck.value) || 0,
      threatBonus: parseFloat(els.ngThreat.value) || 0,
      tradeBonus: parseFloat(els.ngTrade.value) || 0,
      kingSafetyPoints: parseFloat(els.ngKing.value) ?? DEFAULT_CONFIG.kingSafetyPoints,
      mateScore: parseFloat(els.ngMate.value) || DEFAULT_CONFIG.mateScore,
    };
  }

  _startFromModal() {
    const side = this._els.ngSide.find((b) => b.classList.contains('active')).dataset.side;
    const learning = this._els.ngLearning.checked;
    const difficulty = Math.max(DIFF_MIN, Math.min(DIFF_MAX, parseInt(this._els.ngDiff.value) || DIFF_DEFAULT));
    const changed = this._buildGame(this._readNgConfig(), side, learning, difficulty);
    this.setAttribute('color', side);
    this.setAttribute('difficulty', String(difficulty));
    this.setAttribute('learning', String(learning));
    this._saveSettings();
    this._saveGame();
    this._closeNewGame();
    this._render();
    const n = this.learner.count(difficulty);
    if (changed) {
      this._toast(`engine profile ${this._profileFp} — learned exceptions for it: ${n}`);
    }
    this._maybeEngineTurn();
  }

  // ---- game flow ----------------------------------------------------------

  _doUndo() {
    if (this._thinking) return;
    this._epoch++;
    if (this.game.undo()) {
      this._selected = -1; this._pendingPromo = null;
      this._saveGame();
      this._render();
      this._maybeEngineTurn();
    }
  }

  _doResign() {
    if (this._thinking || this.game.isOver()) return;
    this._epoch++;
    this.game.resign();
    this._saveGame();
    this._render();
  }

  _maybeEngineTurn() {
    if (this._restoring || this._thinking) return;
    if (this.game.isOver()) return;
    if (!this.game.isHumanTurn()) this._engineMove();
  }

  async _engineMove() {
    this._thinking = true;
    const epoch = this._epoch;
    this._render();
    const res = await this.game.engineMoveAsync((state, difficulty, opts) => this._provider(state, difficulty, opts));
    if (epoch !== this._epoch || !res) { this._thinking = false; return; }
    this._thinking = false;
    this._afterEngineMove(res);
  }

  // search provider: parallel Lazy SMP via Web Workers when available
  // (worker count scales with difficulty — low depths are too fast to need
  // parallelism and spawning costs more than it saves), else the game's own
  // searcher on the main thread.
  _provider(state, difficulty, opts) {
    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    // parallel root-split scales to ~8 workers; beyond that it's redundancy
    const workerCount = difficulty >= 6 ? Math.min(hw, 8) : 1;
    if (this._worker && workerCount > 1) {
      return parallelSearch({
        state,
        depth: difficulty,
        timeLimitMs: opts.timeLimitMs || 0,
        historyKeys: opts.historyKeys,
        difficulty,
        config: this._config,
        exceptions: this.learner.enabled ? this.learner.exportCompact(difficulty) : [],
        workerCount,
        poolSize: poolSizeForDepth(difficulty, workerCount) * workerCount,
      });
    }
    if (this._worker) {
      const id = ++this._msgId;
      return new Promise((resolve) => {
        this._pending = this._pending || new Map();
        this._pending.set(id, resolve);
        this._worker.postMessage({
          id, type: 'search',
          state: { ...state, b: Array.from(state.b) },
          depth: difficulty,
          timeLimitMs: opts.timeLimitMs || 0,
          historyKeys: opts.historyKeys,
          difficulty,
          config: this._config,
          exceptions: this.learner.enabled ? this.learner.exportCompact(difficulty) : [],
        });
      });
    }
    return this.game.searcher.search(state, difficulty, opts);
  }

  _workerFailed() {
    if (this._worker) { try { this._worker.terminate(); } catch {} this._worker = null; }
    if (this._pending) {
      for (const resolve of this._pending.values()) resolve(null);
      this._pending.clear();
    }
    this._toast('search worker failed — falling back to main thread');
  }

  _onWorkerMessage(msg) {
    if (msg && msg.type === 'search-result' && this._pending && this._pending.has(msg.id)) {
      const resolve = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      resolve({ move: msg.move, score: msg.score, pv: msg.pv, rootScores: msg.rootScores, stats: msg.stats });
    }
  }

  _afterEngineMove(res) {
    if (this.game.learned) {
      const why = this.game.learned.why === 'loss-backtrace' ? 'learned from a past loss'
        : this.game.learned.why === 'reply-refutation' ? 'learned from your reply'
        : 'known exception board';
      this._toast(`🧠 ${why} at depth ${this.game.difficulty} — avoided a bad move`);
    }
    this._saveGame();
    this._render();
    this.dispatchEvent(new CustomEvent('cheap-chess:move', { detail: { result: this.game.result, lastEngine: this.game.lastEngine } }));
  }

  // ---- human interaction --------------------------------------------------

  _onSquareClick(sq) {
    if (this._thinking || this.game.isOver() || !this.game.isHumanTurn()) return;
    if (this._pendingPromo) return;
    const state = this.game.state;
    const pc = state.b[sq];
    if (this._selected >= 0 && sq === this._selected) { this._selected = -1; this._render(); return; }
    if (pc !== 0 && Math.sign(pc) === this.game.humanColor) {
      this._selected = sq;
      this._cursor = sq;
      this._render();
      return;
    }
    if (this._selected >= 0) {
      const from = this._selected;
      const moves = generateLegal(state).filter((m) => mvFrom(m) === from && mvTo(m) === sq);
      if (moves.length === 0) return;
      if (moves.some((m) => mvPromo(m) !== 0)) {
        this._pendingPromo = { from, to: sq };
        this._renderPromo();
        return;
      }
      this._humanMove(from, sq, 0);
    }
  }

  _onKey(e) {
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape'];
    if (!keys.includes(e.key)) return;
    if (this._els.overlay.classList.contains('hidden') === false) return; // modal open
    if (this._pendingPromo) {
      if (e.key === 'Escape') { this._pendingPromo = null; this._render(); }
      return;
    }
    if (this._thinking || this.game.isOver()) return;
    if (this._cursor < 0) this._cursor = 28;
    const flip = this.game.humanColor === BLACK;
    let f = sqFile(this._cursor), r = sqRank(this._cursor);
    const dir = (step) => (flip ? -step : step);
    if (e.key === 'ArrowUp') r += dir(1);
    else if (e.key === 'ArrowDown') r += dir(-1);
    else if (e.key === 'ArrowLeft') f += dir(-1);
    else if (e.key === 'ArrowRight') f += dir(1);
    else if (e.key === 'Enter' || e.key === ' ') {
      if (this._selected >= 0) {
        const moves = generateLegal(this.game.state).filter((m) => mvFrom(m) === this._selected && mvTo(m) === this._cursor);
        if (moves.length) {
          if (moves.some((m) => mvPromo(m) !== 0)) { this._pendingPromo = { from: this._selected, to: this._cursor }; this._renderPromo(); }
          else this._humanMove(this._selected, this._cursor, 0);
        }
        this._selected = -1;
      } else {
        const pc = this.game.state.b[this._cursor];
        if (pc !== 0 && Math.sign(pc) === this.game.humanColor) this._selected = this._cursor;
      }
      this._render();
      return;
    } else if (e.key === 'Escape') { this._selected = -1; }
    if (f < 0 || f > 7 || r < 0 || r > 7) return;
    this._cursor = r * 8 + f;
    this._selected = -1;
    this._render();
    e.preventDefault();
  }

  _humanMove(from, to, promo) {
    const res = this.game.playHuman(from, to, promo);
    if (!res.ok) return;
    if (this.game.learned) this._toast('🧠 your reply taught the engine an exception');
    this._selected = -1;
    this._pendingPromo = null;
    this._saveGame();
    this._render();
    if (this.game.isOver()) {
      if (this.game.result.winner === this.game.humanColor) {
        const ex = this.game.learnFromLoss();
        if (ex) this._toast('🧠 learned from the loss: recorded an exception');
      }
    } else {
      this._engineMove();
    }
    this.dispatchEvent(new CustomEvent('cheap-chess:move', { detail: { result: this.game.result } }));
  }

  _renderPromo() {
    const overlay = this._els.promo;
    overlay.innerHTML = '';
    for (const p of [5, 4, 3, 2]) {
      const btn = document.createElement('button');
      btn.textContent = GLYPHS[p];
      btn.title = 'promote to ' + ({ 5: 'Queen', 4: 'Rook', 3: 'Bishop', 2: 'Knight' })[p];
      btn.addEventListener('click', () => this._humanMove(this._pendingPromo.from, this._pendingPromo.to, p));
      overlay.appendChild(btn);
    }
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'promote (queen is usually right)';
    overlay.appendChild(hint);
    overlay.classList.remove('hidden');
  }

  // ---- rendering ----------------------------------------------------------

  _render() {
    const state = this.game.state;
    const els = this._els;
    const flip = this.game.humanColor === BLACK;
    const lastMove = this.game.lastMove || 0;
    const lastFrom = lastMove ? mvFrom(lastMove) : -1;
    const lastTo = lastMove ? mvTo(lastMove) : -1;
    const kingSq = state.turn === WHITE ? state.wksq : state.bksq;

    const targets = new Set();
    if (this._selected >= 0 && !this.game.isOver() && this.game.isHumanTurn()) {
      for (const m of generateLegal(state)) if (mvFrom(m) === this._selected) targets.add(mvTo(m));
    }

    let html = '';
    for (let i = 0; i < 64; i++) {
      const v = flip ? 63 - i : i;
      const f = sqFile(v), r = sqRank(v);
      const cls = ['sq', ((f + r) & 1) ? 'dark' : 'light'];
      if (v === this._selected) cls.push('selected');
      if (v === lastFrom || v === lastTo) cls.push('last');
      if (v === kingSq && inCheck(state)) cls.push('check');
      const pc = state.b[v];
      const glyph = pc ? GLYPHS[Math.abs(pc)] : '';
      const dot = targets.has(v) ? `<span class="dot"></span>` : '';
      html += `<button class="${cls.join(' ')}" data-sq="${v}" role="gridcell" aria-label="${squareName(v)}${pc ? ' ' + (pc > 0 ? 'white' : 'black') + ' ' + Math.abs(pc) : ''}">${glyph ? `<span class="pc ${pc > 0 ? 'w' : 'b'}">${glyph}</span>` : ''}${dot}</button>`;
    }
    const files = 'abcdefgh';
    const coords = [];
    for (let i = 0; i < 8; i++) {
      const file = flip ? files[7 - i] : files[i];
      const rank = flip ? i + 1 : 8 - i;
      coords.push(`<span class="coord rank" style="--i:${i}">${rank}</span>`);
      coords.push(`<span class="coord file" style="--i:${i}">${file}</span>`);
    }
    els.board.innerHTML = html + coords.join('');

    const r = this.game.result;
    let status;
    if (this._thinking) status = '🧠 engine thinking…';
    else if (r.status === 'ongoing') {
      status = (state.turn === this.game.humanColor ? 'Your turn' : 'Engine') + ' — ' + (state.turn === WHITE ? 'White' : 'Black');
      if (inCheck(state)) status += ' (check!)';
    } else status = this._resultText(r);
    els.status.textContent = status;
    els.status.className = 'cc-status' + (this._thinking ? ' thinking' : '');

    if (r.status !== 'ongoing' && !this._thinking) {
      const cls = r.winner === 0 ? 'draw' : r.winner === this.game.humanColor ? 'win' : 'loss';
      els.banner.className = 'banner ' + cls;
      els.banner.textContent = this._resultText(r);
      els.banner.classList.remove('hidden');
    } else els.banner.classList.add('hidden');

    if (this.game.lastEngine && !this._thinking) {
      const score = -this.game.lastEngine.score; // human's perspective, points
      const frac = Math.max(0, Math.min(1, 0.5 + score / 16000));
      els.evalFill.style.height = (frac * 100) + '%';
      els.evalText.textContent = (score > 0 ? '+' : '') + (score / 1000).toFixed(2) + ' (you)';
      if (this.game.lastEngine.pv && this.game.lastEngine.pv.length) {
        let s = state;
        const pv = [];
        for (const m of this.game.lastEngine.pv.slice(0, 8)) { pv.push(san(s, m)); s = applyMove(s, m); }
        els.pv.textContent = 'PV: ' + pv.join(' ');
      } else els.pv.textContent = '';
    } else { els.evalText.textContent = ''; els.pv.textContent = ''; }

    const ml = this.game.moveList;
    let mlHtml = '';
    for (let i = 0; i < ml.length; i += 2) {
      const n = (i >> 1) + 1;
      mlHtml += `<div><span class="n">${n}.</span> ${ml[i]}${ml[i + 1] ? '  ' + ml[i + 1] : ''}</div>`;
    }
    els.movelist.innerHTML = mlHtml || '<span style="color:var(--cc-dim)">—</span>';
    els.movelist.scrollTop = els.movelist.scrollHeight;

    const st = this.game.stats;
    const ex = this.learner.enabled ? this.learner.count(this.game.difficulty) : 0;
    els.exCount.textContent = `(${ex} learned @ depth ${this.game.difficulty})`;
    els.profile.textContent = `engine profile ${this._profileFp} · learning cache is per-profile`;
    els.stats.textContent = st
      ? `depth ${st.depth}${st.workers ? ` · ${st.workers} threads` : ''} · ${st.nodes.toLocaleString()} nodes · ${st.ms}ms · pool ${st.poolUtil}%${st.poolExhausted ? ' · pool exhausted!' : ''}`
      : '—';
    this._els.promo.classList.add('hidden');
  }

  _resultText(r) {
    switch (r.status) {
      case 'checkmate': return r.winner === this.game.humanColor ? 'Checkmate — you win! 🏆' : 'Checkmate — engine wins. It learned something, maybe.';
      case 'stalemate': return 'Draw — stalemate';
      case 'draw-50': return 'Draw — 50-move rule';
      case 'draw-3fold': return 'Draw — threefold repetition';
      case 'draw-material': return 'Draw — insufficient material';
      case 'resignation': return r.winner === this.game.humanColor ? 'You resigned — engine wins' : 'Engine resigned — you win';
      default: return '';
    }
  }

  // ---- persistence / misc -------------------------------------------------

  _saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        difficulty: this.game.difficulty,
        side: this.side,
        learning: this.learning,
        config: this._config,
      }));
    } catch { /* ignore */ }
  }

  _saveGame() {
    try {
      localStorage.setItem(GAME_KEY, JSON.stringify({
        uci: this.game.uciList || [],
        profile: this._profileFp,
      }));
    } catch { /* ignore */ }
  }

  _restore() {
    this._restoring = true;
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (s) {
        this._buildGame(s.config || DEFAULT_CONFIG, s.side || 'white', s.learning !== false, s.difficulty || DIFF_DEFAULT);
        this.setAttribute('difficulty', String(this.game.difficulty));
        this.setAttribute('color', this.side);
        this.setAttribute('learning', String(this.learning));
        this._saveSettings();
      }
      const g = JSON.parse(localStorage.getItem(GAME_KEY) || 'null');
      if (g && Array.isArray(g.uci) && g.uci.length && g.profile === this._profileFp) {
        for (const m of g.uci) {
          if (this.game.applyUciMove(m).ok === false) break;
        }
      }
    } catch { /* corrupted storage — start fresh */ }
    this._restoring = false;
    this._render();
    this._maybeEngineTurn();
  }

  _exportExceptions() {
    const json = this.game.learner.export();
    const blob = new Blob([json || '{"v":1,"difficulties":{}}'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cheap-chess-exceptions-' + this._profileFp + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _importExceptions(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (this.game.learner.import(reader.result)) {
        this._toast('exceptions imported for this profile');
        this._render();
      } else this._toast('import failed: not a valid exceptions file');
    };
    reader.readAsText(file);
  }

  _toast(text) {
    const t = this._els.toast;
    t.textContent = text;
    t.classList.remove('hidden');
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 300); }, 3500);
  }
}

customElements.define('cheap-chess', CheapChessBoard);
