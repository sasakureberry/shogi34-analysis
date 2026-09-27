import * as R from './engine.js';
import { Tablebase, DRAW, NO_DATA } from './tb.js';

const tb = new Tablebase('data/');
const $ = (id) => document.getElementById(id);

const state = {
  mode: 'analyze',          // analyze | play | edit | help
  line: [{ pos: R.initialPosition(), move: null }],  // line[i].pos は line[i].move を指した後の局面
  cur: 0,
  flipped: false,
  sel: null,                // { sq } または { hand: 種類 }
  hover: null,              // 候補手一覧でマウスが乗っている手
  evals: null,              // 現局面の候補手と評価（null = 計算中）
  evalToken: 0,
  auto: null,
  play: null,               // { side, level, showEval, over }
  edit: null,               // { pos, brush }
};

const cur = () => state.line[state.cur].pos;
const sqName = (s) => 'ABC'[s % 3] + (Math.floor(s / 3) + 1);
const moveKey = (m) => `${m.from}-${m.to}-${m.drop}`;
const mark = (o) => (o === 0 ? '▲' : '△');

function moveText(m, mover) {
  if (m.drop) return `${mark(mover)}${R.NAMES[m.drop]}打 ${sqName(m.to)}`;
  let s = `${mark(mover)}${R.NAMES[m.piece]} ${sqName(m.from)}→${sqName(m.to)}`;
  if (m.promote) s += ' 成';
  if (m.capture) s += `（${R.NAMES[m.capture]}を取る）`;
  return s;
}

// ---- 評価 ----
const valueCache = new Map();
function valueOf(p) {
  const k = R.toCode(p);
  let v = valueCache.get(k);
  if (!v) { v = tb.value(p); valueCache.set(k, v); v.catch(() => valueCache.delete(k)); }
  return v;
}

// 手を指した側から見た結果
async function moveResult(p, m) {
  if (m.capture === R.L) return { kind: 'win', plies: 1 };
  const v = await valueOf(R.applyMove(p, m));
  if (v === NO_DATA) return { kind: 'none', plies: null };
  if (v === DRAW) return { kind: 'draw', plies: null };
  return { kind: v % 2 === 1 ? 'loss' : 'win', plies: v + 1 };
}
function posResult(v) {
  if (v === NO_DATA) return { kind: 'none', plies: null };
  if (v === DRAW) return { kind: 'draw', plies: null };
  return { kind: v % 2 === 1 ? 'win' : 'loss', plies: v };
}
const score = (r) => (r.kind === 'win' ? 1000 - r.plies : r.kind === 'draw' ? 0 : r.kind === 'loss' ? -1000 + r.plies : -2000);

async function evalMoves(p) {
  const moves = R.legalMoves(p);
  const res = await Promise.all(moves.map(async (m) => ({ m, ...(await moveResult(p, m)) })));
  res.sort((a, b) => score(b) - score(a));
  const top = res.length ? score(res[0]) : null;
  for (const r of res) r.best = score(r) === top && r.kind !== 'none';
  return res;
}

function resText(r, short = false) {
  if (r.kind === 'win') return short ? `勝${r.plies}` : `勝ち ${r.plies}手`;
  if (r.kind === 'loss') return short ? `負${r.plies}` : `負け ${r.plies}手`;
  if (r.kind === 'draw') return short ? '分' : '引き分け';
  return short ? '?' : 'データなし';
}

function refreshEvals() {
  const token = ++state.evalToken;
  state.evals = null;
  setStatus('');  // 前の局面での通信エラー表示は消す（また失敗したら出し直す）
  const p = cur();
  if (R.gameResult(p) || repetitionDraw()) { state.evals = []; render(); return; }
  evalMoves(p).then((ev) => {
    if (token !== state.evalToken) return;
    state.evals = ev;
    setStatus('');
    render();
    afterEvals();
  }).catch((e) => {
    // 通信エラー: 知らせて、少し待ってから取り直す（同じ局面のままなら）
    if (token !== state.evalToken) return;
    setStatus(e.message + '。取り直しています…');
    setTimeout(() => { if (token === state.evalToken) refreshEvals(); }, 3000);
  });
}

// ---- 局面の移動 ----
function repetitionCount() {
  const k = R.toCode(cur());
  let n = 0;
  for (let i = 0; i <= state.cur; i++) if (R.toCode(state.line[i].pos) === k) n++;
  return n;
}
const repetitionDraw = () => repetitionCount() >= 3;

function goTo(i) {
  i = Math.max(0, Math.min(state.line.length - 1, i));
  if (i === state.cur && state.evals) return;
  state.cur = i;
  state.sel = null;
  state.hover = null;
  refreshEvals();
  render();
  saveHash();
}

function doMove(m) {
  const p = cur();
  const next = state.line[state.cur + 1];
  if (next && next.move && moveKey(next.move) === moveKey(m)) { goTo(state.cur + 1); return; }
  state.line = state.line.slice(0, state.cur + 1);
  state.line.push({ pos: R.applyMove(p, m), move: m });
  goTo(state.cur + 1);
}

function stopAuto() {
  if (state.auto) { clearTimeout(state.auto); state.auto = null; }
}

function afterEvals() {
  if (state.mode === 'play') maybeAiMove();
  if (state.auto) return;
}

function pickBest(ev, random) {
  const best = ev.filter((r) => r.best);
  if (!best.length) return null;
  return random ? best[Math.floor(Math.random() * best.length)] : best[0];
}

// ---- 対局 ----
function aiChoose(ev, level) {
  if (!ev.length) return null;
  const known = ev.filter((r) => r.kind !== 'none');
  if (!known.length) return ev[Math.floor(Math.random() * ev.length)];
  if (level >= 3) return pickBest(known, true);
  const winNow = known.filter((r) => r.kind === 'win' && r.plies === 1);
  if (winNow.length) return winNow[0];
  const limit = level === 2 ? 4 : 2;
  const safe = known.filter((r) => !(r.kind === 'loss' && r.plies <= limit));
  if (level === 2 && Math.random() < 0.7) return pickBest(known, true);
  const pool = safe.length ? safe : known;
  return pool[Math.floor(Math.random() * pool.length)];
}

function maybeAiMove() {
  const pl = state.play;
  if (!pl || pl.over) return;
  const p = cur();
  if (checkGameOver()) return;
  if (p.turn === pl.side || !state.evals) return;
  const token = state.evalToken;
  setTimeout(() => {
    if (token !== state.evalToken || state.mode !== 'play') return;
    const r = aiChoose(state.evals, pl.level);
    if (r) doMove(r.m);
  }, 450);
}

function checkGameOver() {
  const pl = state.play;
  if (!pl) return false;
  const g = R.gameResult(cur());
  if (g) { pl.over = true; $('play-msg').textContent = g.winner === pl.side ? 'あなたの勝ちです！' : '負けました。'; return true; }
  if (repetitionDraw()) { pl.over = true; $('play-msg').textContent = '同じ局面が3回になったので引き分けです。'; return true; }
  return false;
}

function startPlay(fromHere) {
  stopAuto();
  const pos = fromHere ? R.clonePos(cur()) : R.initialPosition();
  state.play = {
    side: +$('play-side').value,
    level: +$('play-level').value,
    showEval: $('play-show-eval').checked,
    over: false,
  };
  state.flipped = state.play.side === 1;
  state.line = [{ pos, move: null }];
  state.cur = 0;
  $('play-msg').textContent = '';
  state.evals = null;
  goTo(0);
  refreshEvals();
}

// ---- 描画 ----
function pieceEl(t, o, up) {
  const el = document.createElement('div');
  el.className = `piece o${o} ${up ? 'up' : 'down'}`;
  el.textContent = R.GLYPHS[t];
  el.title = R.NAMES[t];
  for (const [dr, dc] of R.dirsOf(t, 0)) {
    const pip = document.createElement('span');
    pip.className = 'pip';
    pip.style.left = 50 + dc * 43 + '%';
    pip.style.top = 50 + dr * 43 + '%';
    el.appendChild(pip);
  }
  return el;
}

function showEval() {
  if (state.mode === 'analyze') return true;
  if (state.mode === 'play') return state.play && (state.play.showEval || state.play.over);
  return false;
}

function selectedTargets() {
  if (!state.sel || !state.evals) return new Map();
  const map = new Map();
  for (const r of state.evals) {
    const m = r.m;
    if (state.sel.sq !== undefined ? m.from === state.sel.sq : m.drop === state.sel.hand) map.set(m.to, r);
  }
  return map;
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  cellEls.length = 0;
  const editing = state.mode === 'edit';
  const p = editing ? state.edit.pos : cur();
  const targets = editing ? new Map() : selectedTargets();
  // 候補手にカーソルが乗っているときは、その手の行き先にも評価を出す（矢印の先）
  if (!editing && state.hover) targets.set(state.hover.m.to, state.hover);
  const lastMove = !editing && state.line[state.cur].move;
  let best = null;
  if (!editing && showEval() && !state.sel && state.evals) best = state.hover ? null : pickBest(state.evals, false);
  for (let d = 0; d < 12; d++) {
    const s = state.flipped ? 11 - d : d;
    const cell = document.createElement('div');
    cell.className = 'cell';
    const row = Math.floor(s / 3);
    if (row === 0) cell.classList.add(state.flipped ? 'zone-bottom' : 'zone-top');
    if (row === 3) cell.classList.add(state.flipped ? 'zone-top' : 'zone-bottom');
    if (lastMove && (lastMove.to === s || lastMove.from === s)) cell.classList.add('last');
    if (best && (best.m.to === s || best.m.from === s)) cell.classList.add(best.m.to === s ? 'best-to' : 'best-from');
    if (state.sel && state.sel.sq === s) cell.classList.add('sel');
    const pc = p.board[s];
    if (pc) cell.appendChild(pieceEl(pc.t, pc.o, (pc.o === 0) !== state.flipped));
    const tr = targets.get(s);
    if (tr) {
      cell.classList.add('target');
      if (showEval()) {
        const b = document.createElement('span');
        b.className = `badge ${tr.kind}-b${pc ? '' : ' alone'}`;
        b.textContent = resText(tr, true);
        cell.appendChild(b);
        cell.classList.add('has-badge');
      }
    }
    cell.addEventListener('click', () => onCell(s));
    cellEls[s] = cell;
    board.appendChild(cell);
  }
  $('files-top').innerHTML = (state.flipped ? ['C', 'B', 'A'] : ['A', 'B', 'C']).map((x) => `<span>${x}</span>`).join('');
  $('ranks').innerHTML = (state.flipped ? [4, 3, 2, 1] : [1, 2, 3, 4]).map((x) => `<span>${x}</span>`).join('');
}

const cellEls = [];
const SVGNS = 'http://www.w3.org/2000/svg';

// 候補手にカーソルが乗っているとき、移動元（打つ手は持ち駒）から移動先へ矢印を描く
function drawArrow() {
  const svg = $('arrow-layer');
  svg.innerHTML = '';
  const r = state.hover;
  if (!r || state.mode === 'edit' || state.mode === 'help') return;
  const m = r.m, p = cur();
  let fromEl = null;
  if (m.drop) fromEl = document.querySelector(`.hand-piece[data-owner="${p.turn}"][data-type="${m.drop}"]`);
  else fromEl = cellEls[m.from];
  const toEl = cellEls[m.to];
  if (!fromEl || !toEl) return;
  const base = svg.getBoundingClientRect();
  const center = (el) => { const b = el.getBoundingClientRect(); return [b.left + b.width / 2 - base.left, b.top + b.height / 2 - base.top]; };
  const [x1, y1] = center(fromEl), [x2, y2] = center(toEl);
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const cell = toEl.getBoundingClientRect().width;
  const w = Math.max(6, cell * 0.1), head = w * 2.6, start = cell * 0.18, end = cell * 0.12;
  const sx = x1 + ux * start, sy = y1 + uy * start;
  const ex = x2 - ux * end, ey = y2 - uy * end;
  const bx = ex - ux * head, by = ey - uy * head;
  const nx = -uy, ny = ux;
  const line = document.createElementNS(SVGNS, 'line');
  line.setAttribute('x1', sx); line.setAttribute('y1', sy);
  line.setAttribute('x2', bx); line.setAttribute('y2', by);
  line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', w); line.setAttribute('stroke-linecap', 'round');
  const tip = document.createElementNS(SVGNS, 'polygon');
  tip.setAttribute('points', `${ex},${ey} ${bx + nx * head * 0.62},${by + ny * head * 0.62} ${bx - nx * head * 0.62},${by - ny * head * 0.62}`);
  tip.setAttribute('fill', 'currentColor');
  svg.append(line, tip);
}
window.addEventListener('resize', drawArrow);

function renderHands() {
  const editing = state.mode === 'edit';
  const p = editing ? state.edit.pos : cur();
  for (const [id, owner] of [['hand-top', state.flipped ? 0 : 1], ['hand-bottom', state.flipped ? 1 : 0]]) {
    const el = $(id);
    el.innerHTML = `<span class="who">${owner === 0 ? '▲先手' : '△後手'}</span>`;
    const up = (owner === 0) !== state.flipped;
    for (let i = 0; i < 3; i++) {
      const t = R.HAND_TYPES[i], n = p.hands[owner][i];
      if (editing) {
        const wrap = document.createElement('div');
        wrap.className = 'edit-count';
        const hp = document.createElement('div');
        hp.className = 'hand-piece';
        hp.appendChild(pieceEl(t, owner, up));
        const c = document.createElement('span'); c.className = 'count'; c.textContent = n; hp.appendChild(c);
        const btns = document.createElement('div');
        const minus = document.createElement('button'); minus.textContent = '−';
        const plus = document.createElement('button'); plus.textContent = '+';
        minus.onclick = () => { if (n > 0) { p.hands[owner][i]--; renderEdit(); } };
        plus.onclick = () => { if (n < 2) { p.hands[owner][i]++; renderEdit(); } };
        btns.append(minus, plus);
        wrap.append(hp, btns);
        el.appendChild(wrap);
        continue;
      }
      if (!n) continue;
      const hp = document.createElement('div');
      hp.className = 'hand-piece';
      if (state.sel && state.sel.hand === t && p.turn === owner) hp.classList.add('sel');
      hp.appendChild(pieceEl(t, owner, up));
      if (n > 1) { const c = document.createElement('span'); c.className = 'count'; c.textContent = '×' + n; hp.appendChild(c); }
      hp.dataset.owner = owner;
      hp.dataset.type = t;
      hp.addEventListener('click', () => onHand(owner, t));
      el.appendChild(hp);
    }
  }
}

function renderVerdict() {
  const el = $('verdict');
  el.className = 'verdict';
  if (state.mode === 'edit') { el.textContent = '局面編集中'; return; }
  const p = cur();
  const g = R.gameResult(p);
  const who = (o) => (o === 0 ? '先手' : '後手');
  if (g) {
    el.innerHTML = `${who(g.winner)}の勝ち<small>${g.reason === 'try' ? 'ライオンが相手の陣に入った（トライ）' : 'ライオンを取った'}</small>`;
    el.classList.add(state.play ? (g.winner === state.play.side ? 'win' : 'loss') : 'draw');
    return;
  }
  if (repetitionDraw()) { el.innerHTML = '引き分け<small>同じ局面が3回あらわれた（千日手）</small>'; el.classList.add('draw'); return; }
  const turnText = `${mark(p.turn)}${who(p.turn)}の番`;
  if (!showEval()) { el.innerHTML = `${turnText}<small>${state.play && p.turn !== state.play.side ? '相手が考えています…' : ''}</small>`; return; }
  el.innerHTML = `${turnText}<small>計算中…</small>`;
  const token = state.evalToken;
  valueOf(p).then((v) => {
    if (token !== state.evalToken) return;
    const r = posResult(v);
    el.className = 'verdict';
    if (r.kind === 'none') { el.innerHTML = `${turnText}<small>この局面の解析データはありません（初期局面から到達できない形）</small>`; return; }
    if (r.kind === 'draw') { el.innerHTML = `引き分け<small>${turnText}・お互い最善なら決着がつきません</small>`; el.classList.add('draw'); return; }
    const winner = r.kind === 'win' ? p.turn : 1 - p.turn;
    el.innerHTML = `${who(winner)}の勝ち（あと${r.plies}手）<small>${turnText}・お互い最善を尽くした場合</small>`;
    el.classList.add(r.kind);
  }).catch(() => {});  // 通信エラーは候補手の取り直し側で知らせる
}

function renderMoves() {
  const ol = $('moves');
  ol.innerHTML = '';
  const note = $('moves-note');
  const p = cur();
  if (state.mode === 'edit') { note.textContent = ''; return; }
  if (!state.evals) { note.textContent = '計算中…'; return; }
  if (!state.evals.length) { note.textContent = '決着済み'; return; }
  const visible = showEval();
  note.textContent = `${state.evals.length}通り`;
  for (const r of state.evals) {
    const li = document.createElement('li');
    const mv = document.createElement('span');
    mv.className = 'mv';
    mv.textContent = moveText(r.m, p.turn);
    if (visible && r.best) { const tag = document.createElement('span'); tag.className = 'best-tag'; tag.textContent = '最善'; mv.appendChild(tag); }
    const ev = document.createElement('span');
    ev.className = 'ev ' + (visible ? r.kind : 'none');
    ev.textContent = visible ? resText(r) : '';
    li.append(mv, ev);
    if (state.hover && moveKey(state.hover.m) === moveKey(r.m)) li.classList.add('hl');
    li.addEventListener('click', () => { if (canHumanMove()) doMove(r.m); });
    li.addEventListener('mouseenter', () => { state.hover = r; li.classList.add('hl'); renderBoard(); drawArrow(); });
    li.addEventListener('mouseleave', () => { state.hover = null; li.classList.remove('hl'); renderBoard(); drawArrow(); });
    ol.appendChild(li);
  }
}

const kifuMarks = new Map();  // `${親の局面コード}|${手}` → 印
async function kifuMark(parent, m) {
  const k = R.toCode(parent) + '|' + moveKey(m);
  if (kifuMarks.has(k)) return kifuMarks.get(k);
  const best = posResult(await valueOf(parent));
  const got = await moveResult(parent, m);
  let res = { cls: '', text: '' };
  if (best.kind !== 'none' && got.kind !== 'none') {
    if (best.kind === 'win' && got.kind !== 'win') res = { cls: 'loss', text: got.kind === 'draw' ? '✗ 勝ち→引き分け' : '✗ 勝ち→負け' };
    else if (best.kind === 'draw' && got.kind === 'loss') res = { cls: 'loss', text: '✗ 引き分け→負け' };
    else if (best.kind === 'win' && got.plies > best.plies) res = { cls: 'slow', text: `△ +${got.plies - best.plies}手` };
    else if (best.kind === 'loss' && got.plies < best.plies) res = { cls: 'loss', text: `✗ ${best.plies - got.plies}手早く負け` };
  }
  kifuMarks.set(k, res);
  return res;
}

function renderKifu() {
  const ol = $('kifu');
  ol.innerHTML = '';
  const head = document.createElement('li');
  head.innerHTML = `<span class="no">0</span><span>開始局面</span><span></span>`;
  if (state.cur === 0) head.classList.add('cur');
  head.addEventListener('click', () => { if (state.mode === 'analyze') goTo(0); });
  ol.appendChild(head);
  const showMarks = showEval();
  for (let i = 1; i < state.line.length; i++) {
    const li = document.createElement('li');
    const parent = state.line[i - 1].pos;
    const m = state.line[i].move;
    li.innerHTML = `<span class="no">${i}</span><span>${moveText(m, parent.turn)}</span><span class="mark"></span>`;
    if (i === state.cur) li.classList.add('cur');
    li.addEventListener('click', () => { if (state.mode === 'analyze') goTo(i); });
    if (showMarks) {
      const mk = li.querySelector('.mark');
      kifuMark(parent, m).then((r) => { mk.textContent = r.text; mk.className = 'mark ' + r.cls; }).catch(() => {});
    }
    ol.appendChild(li);
  }
  const c = ol.querySelector('.cur');
  if (c) c.scrollIntoView({ block: 'nearest' });
}

function renderControls() {
  const analyze = state.mode === 'analyze', play = state.mode === 'play';
  $('nav-controls').hidden = !(analyze || play);
  $('edit-tools').hidden = state.mode !== 'edit';
  $('play-tools').hidden = !play;
  for (const id of ['btn-first', 'btn-next', 'btn-last', 'btn-best', 'btn-auto']) $(id).hidden = play;
  $('btn-prev').textContent = play ? '待った' : '◀';
  $('btn-prev').disabled = state.cur === 0;
  $('btn-first').disabled = state.cur === 0;
  $('btn-next').disabled = state.cur >= state.line.length - 1;
  $('btn-last').disabled = state.cur >= state.line.length - 1;
  const over = !!R.gameResult(cur()) || repetitionDraw();
  $('btn-best').disabled = over || !state.evals;
  $('btn-auto').textContent = state.auto ? '■ 停止' : '▶ 最善手順';
  $('btn-auto').classList.toggle('on', !!state.auto);
  for (const b of document.querySelectorAll('.modes button')) b.classList.toggle('on', b.dataset.mode === state.mode);
  const help = state.mode === 'help';
  $('help').hidden = !help;
  document.querySelector('.board-area').hidden = help;
  document.querySelector('.side').hidden = help;
}

function render() {
  if (state.mode === 'help') { renderControls(); return; }
  renderBoard();
  renderHands();
  drawArrow();
  renderVerdict();
  renderMoves();
  if (state.mode !== 'edit') renderKifu();
  renderControls();
}

// ---- 入力 ----
function canHumanMove() {
  if (state.mode === 'analyze') return true;
  if (state.mode === 'play') return state.play && !state.play.over && cur().turn === state.play.side;
  return false;
}

function onCell(s) {
  if (state.mode === 'edit') { editCell(s); return; }
  if (!canHumanMove()) return;
  const p = cur();
  if (R.gameResult(p)) return;
  if (state.sel && state.evals) {
    const r = selectedTargets().get(s);
    if (r) { stopAuto(); doMove(r.m); return; }
  }
  const pc = p.board[s];
  state.sel = pc && pc.o === p.turn && !(state.sel && state.sel.sq === s) ? { sq: s } : null;
  render();
}

function onHand(owner, t) {
  if (!canHumanMove()) return;
  const p = cur();
  if (owner !== p.turn || R.gameResult(p)) return;
  state.sel = state.sel && state.sel.hand === t ? null : { hand: t };
  render();
}

// ---- 局面編集 ----
function enterEdit() {
  stopAuto();
  state.edit = { pos: R.clonePos(cur()), brush: { t: R.L, o: 0 } };
  state.mode = 'edit';
  $('edit-msg').textContent = '';
  buildPalette();
  render();
  renderEdit();
}

function buildPalette() {
  const pal = $('palette');
  pal.innerHTML = '';
  const items = [];
  for (const o of [0, 1]) for (const t of [R.L, R.G, R.E, R.C, R.H]) items.push({ t, o });
  items.push('erase');
  for (const it of items) {
    const b = document.createElement('button');
    if (it === 'erase') { b.textContent = '消す'; } else b.appendChild(pieceEl(it.t, it.o, it.o === 0));
    b.onclick = () => { state.edit.brush = it; renderEdit(); };
    b.dataset.key = it === 'erase' ? 'erase' : `${it.t}-${it.o}`;
    pal.appendChild(b);
  }
}

function renderEdit() {
  const br = state.edit.brush;
  const key = br === 'erase' ? 'erase' : `${br.t}-${br.o}`;
  for (const b of $('palette').children) b.classList.toggle('on', b.dataset.key === key);
  $('edit-turn').textContent = state.edit.pos.turn === 0 ? '▲先手の番' : '△後手の番';
  const err = R.validatePos(state.edit.pos);
  $('edit-msg').textContent = err || '';
  $('edit-done').disabled = !!err;
  renderBoard();
  renderHands();
  renderVerdict();
}

function editCell(s) {
  const p = state.edit.pos, br = state.edit.brush;
  if (br === 'erase') p.board[s] = null;
  else if (p.board[s] && p.board[s].t === br.t && p.board[s].o === br.o) p.board[s] = null;
  else {
    if (br.t === R.L) for (let i = 0; i < 12; i++) if (p.board[i] && p.board[i].t === R.L && p.board[i].o === br.o) p.board[i] = null;
    p.board[s] = { t: br.t, o: br.o };
  }
  renderEdit();
}

function finishEdit() {
  const p = state.edit.pos;
  if (R.validatePos(p)) return;
  state.mode = 'analyze';
  state.play = null;
  state.line = [{ pos: R.clonePos(p), move: null }];
  state.cur = 0;
  state.edit = null;
  state.evals = null;
  goTo(0);
  refreshEvals();
}

// ---- URL 共有 ----
const SQ = 'abcdefghijkl';
const DROPCH = { 2: 'G', 3: 'E', 4: 'C' };
function saveHash() {
  if (state.mode === 'play') return;
  let s = R.toCode(state.line[0].pos) + '~';
  for (let i = 1; i < state.line.length; i++) {
    const m = state.line[i].move;
    s += m.drop ? DROPCH[m.drop] + SQ[m.to] : SQ[m.from] + SQ[m.to];
  }
  s += '~' + state.cur;
  history.replaceState(null, '', '#' + s);
}
function loadHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return;
  const [code, mv = '', c = ''] = h.split('~');
  const start = R.fromCode(code);
  if (!start || R.validatePos(start)) return;
  const line = [{ pos: start, move: null }];
  for (let i = 0; i + 1 < mv.length; i += 2) {
    const p = line[line.length - 1].pos;
    const a = mv[i], to = SQ.indexOf(mv[i + 1]);
    const m = R.legalMoves(p).find((x) => x.to === to && (SQ.includes(a) ? x.from === SQ.indexOf(a) : x.drop && DROPCH[x.drop] === a));
    if (!m || R.gameResult(p)) break;
    line.push({ pos: R.applyMove(p, m), move: m });
  }
  state.line = line;
  const ci = parseInt(c, 10);
  state.cur = Number.isFinite(ci) ? Math.max(0, Math.min(line.length - 1, ci)) : line.length - 1;
}

// ---- その他 ----
function setStatus(t) { $('status').textContent = t; }
function toast(t) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = t;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function autoStep() {
  state.auto = null;
  const run = () => {
    if (!state.evals) { state.auto = setTimeout(run, 150); return; }
    const r = pickBest(state.evals, false);
    if (!r || R.gameResult(cur()) || repetitionDraw()) { stopAuto(); render(); return; }
    doMove(r.m);
    state.auto = setTimeout(run, 700);
    renderControls();
  };
  state.auto = setTimeout(run, 0);
  renderControls();
}

function setMode(mode) {
  if (mode === state.mode) return;
  stopAuto();
  if (mode === 'edit') { enterEdit(); return; }
  if (state.mode === 'edit') state.edit = null;
  if (mode === 'analyze' && state.mode === 'play') { state.play = null; saveHash(); }
  state.mode = mode;
  if (mode === 'play' && !state.play) {
    $('play-msg').textContent = '設定を選んで「対局開始」を押してください。';
  }
  state.sel = null;
  refreshEvals();
  render();
}

function undoPlay() {
  // 待った: 自分の番まで戻して、その先を消す
  let i = state.cur - 1;
  while (i > 0 && state.line[i].pos.turn !== state.play.side) i--;
  if (i < 0) return;
  state.line = state.line.slice(0, i + 1);
  state.play.over = false;
  $('play-msg').textContent = '';
  goTo(i);
}

function bind() {
  for (const b of document.querySelectorAll('.modes button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('btn-first').onclick = () => { stopAuto(); goTo(0); };
  $('btn-prev').onclick = () => { stopAuto(); if (state.mode === 'play' && state.play) undoPlay(); else goTo(state.cur - 1); };
  $('btn-next').onclick = () => { stopAuto(); goTo(state.cur + 1); };
  $('btn-last').onclick = () => { stopAuto(); goTo(state.line.length - 1); };
  $('btn-best').onclick = () => { stopAuto(); const r = state.evals && pickBest(state.evals, false); if (r) doMove(r.m); };
  $('btn-auto').onclick = () => { if (state.auto) { stopAuto(); renderControls(); } else autoStep(); };
  $('btn-flip').onclick = () => { state.flipped = !state.flipped; render(); };
  $('btn-copy').onclick = async () => {
    saveHash();
    try { await navigator.clipboard.writeText(location.href); toast('URLをコピーしました'); } catch { toast('コピーできませんでした'); }
  };
  $('edit-turn').onclick = () => { state.edit.pos.turn = 1 - state.edit.pos.turn; renderEdit(); };
  $('edit-initial').onclick = () => { state.edit.pos = R.initialPosition(); renderEdit(); };
  $('edit-clear').onclick = () => {
    const p = { board: Array(12).fill(null), hands: [[0, 0, 0], [0, 0, 0]], turn: 0 };
    p.board[10] = { t: R.L, o: 0 }; p.board[1] = { t: R.L, o: 1 };
    p.hands[0] = [1, 1, 1]; p.hands[1] = [1, 1, 1];
    state.edit.pos = p; renderEdit();
  };
  $('edit-done').onclick = finishEdit;
  $('edit-cancel').onclick = () => { state.edit = null; state.mode = 'analyze'; refreshEvals(); render(); };
  $('play-start').onclick = () => startPlay(false);
  $('play-here').onclick = () => startPlay(true);
  $('play-show-eval').onchange = () => { if (state.play) state.play.showEval = $('play-show-eval').checked; render(); };
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || state.mode !== 'analyze') return;
    if (e.key === 'ArrowLeft') { stopAuto(); goTo(state.cur - 1); }
    else if (e.key === 'ArrowRight') { stopAuto(); goTo(state.cur + 1); }
    else if (e.key === 'b' || e.key === 'B') $('btn-best').click();
    else if (e.key === 'f' || e.key === 'F') $('btn-flip').click();
    else return;
    e.preventDefault();
  });
}

bind();
loadHash();
tb.ready.then(() => setStatus('')).catch((e) => setStatus(e.message));
refreshEvals();
render();
