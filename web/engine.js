// ルールと局面番号（solver/solver.c と同じ番号付け）
//
// 盤は 3 列 × 4 段。マス s = row*3 + col。row 0 が上（後手の陣）、row 3 が下（先手の陣）。
// 駒: 1 ライオン 2 キリン 3 ゾウ 4 ヒヨコ 5 ニワトリ。持ち駒の種類: 0 キリン 1 ゾウ 2 ヒヨコ。
// 局面: { board: [{t, o}|null ×12], hands: [[G,E,C],[G,E,C]], turn: 0 先手 / 1 後手 }

export const L = 1, G = 2, E = 3, C = 4, H = 5;
export const NAMES = { 1: 'ライオン', 2: 'キリン', 3: 'ゾウ', 4: 'ヒヨコ', 5: 'ニワトリ' };
export const HAND_TYPES = [G, E, C];
// 盤上の駒の表示（一文字）。カタカナにするなら { 1: 'ラ', 2: 'キ', 3: 'ゾ', 4: 'ヒ', 5: 'ニ' }
export const GLYPHS = { 1: 'ら', 2: 'き', 3: 'ぞ', 4: 'ひ', 5: 'に' };

const DIRS = {
  1: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
  2: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  3: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  4: [[-1, 0]],
  5: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]],
};
export function dirsOf(t, owner) {
  return owner === 0 ? DIRS[t] : DIRS[t].map(([r, c]) => [-r, -c]);
}

// 相手の陣（成る段）: 先手は row 0、後手は row 3
export const farRow = (owner) => (owner === 0 ? 0 : 3);

export function initialPosition() {
  const b = Array(12).fill(null);
  b[0] = { t: G, o: 1 }; b[1] = { t: L, o: 1 }; b[2] = { t: E, o: 1 }; b[4] = { t: C, o: 1 };
  b[7] = { t: C, o: 0 }; b[9] = { t: E, o: 0 }; b[10] = { t: L, o: 0 }; b[11] = { t: G, o: 0 };
  return { board: b, hands: [[0, 0, 0], [0, 0, 0]], turn: 0 };
}

export function clonePos(p) {
  return { board: p.board.map((x) => (x ? { ...x } : null)), hands: [p.hands[0].slice(), p.hands[1].slice()], turn: p.turn };
}

const handIndex = (t) => (t === G ? 0 : t === E ? 1 : 2); // C, H → 2

// 手: { from: s | null, to: s, drop: t | null, promote: bool, capture: t | null, piece: t }
export function legalMoves(p) {
  const me = p.turn, moves = [];
  for (let s = 0; s < 12; s++) {
    const pc = p.board[s];
    if (!pc || pc.o !== me) continue;
    const r = Math.floor(s / 3), c = s % 3;
    for (const [dr, dc] of dirsOf(pc.t, me)) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > 3 || cc < 0 || cc > 2) continue;
      const t = rr * 3 + cc, tgt = p.board[t];
      if (tgt && tgt.o === me) continue;
      moves.push({ from: s, to: t, drop: null, piece: pc.t, capture: tgt ? tgt.t : null, promote: pc.t === C && rr === farRow(me) });
    }
  }
  for (let i = 0; i < 3; i++) {
    if (!p.hands[me][i]) continue;
    for (let t = 0; t < 12; t++) {
      if (p.board[t]) continue;
      moves.push({ from: null, to: t, drop: HAND_TYPES[i], piece: HAND_TYPES[i], capture: null, promote: false });
    }
  }
  return moves;
}

export function applyMove(p, m) {
  const q = clonePos(p), me = p.turn;
  if (m.drop) {
    q.hands[me][handIndex(m.drop)]--;
    q.board[m.to] = { t: m.drop, o: me };
  } else {
    const pc = q.board[m.from], tgt = q.board[m.to];
    if (tgt && tgt.t !== L) q.hands[me][handIndex(tgt.t)]++;
    q.board[m.to] = { t: m.promote ? H : pc.t, o: me };
    q.board[m.from] = null;
  }
  q.turn = 1 - me;
  return q;
}

export function lionSquare(p, owner) {
  for (let s = 0; s < 12; s++) if (p.board[s] && p.board[s].t === L && p.board[s].o === owner) return s;
  return -1;
}

export function attacks(p, owner, target) {
  for (let s = 0; s < 12; s++) {
    const pc = p.board[s];
    if (!pc || pc.o !== owner) continue;
    const r = Math.floor(s / 3), c = s % 3;
    for (const [dr, dc] of dirsOf(pc.t, owner)) if ((r + dr) * 3 + (c + dc) === target && r + dr >= 0 && r + dr <= 3 && c + dc >= 0 && c + dc <= 2) return true;
  }
  return false;
}

// 決着の判定。{ winner, reason } または null
export function gameResult(p) {
  const me = p.turn, op = 1 - me;
  if (lionSquare(p, me) < 0) return { winner: op, reason: 'catch' };
  const ol = lionSquare(p, op);
  if (ol < 0) return { winner: me, reason: 'catch' };
  // 相手ライオンが手番側の陣に入っていて、取れない → トライ成立
  if (Math.floor(ol / 3) === farRow(op) && !attacks(p, me, ol)) return { winner: op, reason: 'try' };
  return null;
}

// ---- 局面番号 ----
const T = (() => {
  const lidx = [], lmy = [], lop = [], freeSq = [];
  let li = 0;
  for (let a = 0; a < 12; a++) {
    lidx.push([]);
    for (let b = 0; b < 12; b++) {
      if (a === b) { lidx[a].push(-1); continue; }
      lidx[a].push(li); lmy.push(a); lop.push(b);
      const fs = [];
      for (let s = 0; s < 12; s++) if (s !== a && s !== b) fs.push(s);
      freeSq.push(fs); li++;
    }
  }
  const srank = new Int32Array(1024), sunrank = [], cnt = Array(11).fill(0);
  for (let k = 0; k <= 10; k++) sunrank.push([]);
  for (let m = 0; m < 1024; m++) {
    let k = 0; for (let x = m; x; x &= x - 1) k++;
    srank[m] = cnt[k]; sunrank[k].push(m); cnt[k]++;
  }
  const comboOf = [], combos = [];
  for (let g = 0; g < 3; g++) { comboOf.push([]); for (let e = 0; e < 3; e++) { comboOf[g].push([]); for (let c = 0; c < 3; c++) { comboOf[g][e].push(combos.length); combos.push({ g, e, c, k: g + e + c, punrank: [] }); } } }
  const prank = [];
  for (let k = 0; k <= 6; k++) {
    const p3 = 3 ** k, arr = new Int32Array(p3);
    for (let code = 0; code < p3; code++) {
      const n = [0, 0, 0]; let x = code;
      for (let i = 0; i < k; i++) { n[x % 3]++; x = Math.floor(x / 3); }
      if (n[0] > 2 || n[1] > 2 || n[2] > 2) { arr[code] = -1; continue; }
      const cb = combos[comboOf[n[0]][n[1]][n[2]]];
      arr[code] = cb.punrank.length; cb.punrank.push(code);
    }
    prank.push(arr);
  }
  const binom = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return r; };
  let off = 0;
  for (const cb of combos) {
    cb.nperm = cb.punrank.length;
    cb.size = binom(10, cb.k) * cb.nperm * 2 ** cb.k * 2 ** cb.c * (3 - cb.g) * (3 - cb.e) * (3 - cb.c);
    cb.off = off; off += cb.size;
  }
  return { lidx, lmy, lop, freeSq, srank, sunrank, comboOf, combos, prank, S: off, N: off * 132 };
})();
export const N_POS = T.N;

// 手番側を「自分」として、自分が下から上へ進む向きにそろえた盤（C 版と同じ表現）
function normalized(p) {
  const b = new Array(12);
  const hm = p.hands[p.turn], ho = p.hands[1 - p.turn];
  for (let s = 0; s < 12; s++) {
    const src = p.turn === 0 ? s : 11 - s;
    const pc = p.board[src];
    b[s] = pc ? pc.t | (pc.o === p.turn ? 0 : 8) : 0;
  }
  return { b, hm, ho };
}

export function rankPos(p) {
  const { b, hm } = normalized(p);
  let my = -1, op = -1;
  for (let s = 0; s < 12; s++) { if (b[s] === L) my = s; else if (b[s] === (L | 8)) op = s; }
  if (my < 0 || op < 0) return -1;
  const li = T.lidx[my][op], fs = T.freeSq[li];
  let mask = 0, code = 0, p3 = 1, owner = 0, promo = 0, k = 0;
  const n = [0, 0, 0];
  for (let j = 0; j < 10; j++) {
    const pc = b[fs[j]];
    if (!pc) continue;
    const t = pc & 7, d = handIndex(t);
    mask |= 1 << j; code += d * p3; p3 *= 3;
    if (pc & 8) owner |= 1 << k;
    if (d === 2 && t === H) promo |= 1 << n[2];
    n[d]++; k++;
  }
  if (n[0] > 2 || n[1] > 2 || n[2] > 2) return -1;
  const cb = T.combos[T.comboOf[n[0]][n[1]][n[2]]];
  if (hm[0] > 2 - n[0] || hm[1] > 2 - n[1] || hm[2] > 2 - n[2]) return -1;
  let r = T.srank[mask] * cb.nperm + T.prank[k][code];
  r = r * 2 ** k + owner;
  r = r * 2 ** n[2] + promo;
  r = r * (3 - n[0]) + hm[0];
  r = r * (3 - n[1]) + hm[1];
  r = r * (3 - n[2]) + hm[2];
  return li * T.S + cb.off + r;
}

// 左右反転した局面（評価は同じ）
export function mirrorPos(p) {
  const q = clonePos(p);
  for (let s = 0; s < 12; s++) { const r = Math.floor(s / 3), c = s % 3; q.board[r * 3 + (2 - c)] = p.board[s] ? { ...p.board[s] } : null; }
  return q;
}

// 局面の検査（編集用）。問題があれば文言を返す
export function validatePos(p) {
  const count = { 1: [0, 0], 2: 0, 3: 0, 4: 0 };
  for (const pc of p.board) {
    if (!pc) continue;
    if (pc.t === L) count[1][pc.o]++;
    else count[pc.t === H ? C : pc.t]++;
  }
  for (let o = 0; o < 2; o++) for (let i = 0; i < 3; i++) count[HAND_TYPES[i]] += p.hands[o][i];
  if (count[1][0] !== 1 || count[1][1] !== 1) return 'ライオンは先手・後手に1枚ずつ必要です';
  for (const t of [G, E, C]) if (count[t] !== 2) return `${NAMES[t]}は盤上と持ち駒を合わせて2枚にしてください（今 ${count[t]} 枚）`;
  return null;
}

// ---- 局面の文字列（URL 共有用）----
// 盤12マス（上段左から）: 先手 L G E C H / 後手 l g e c h / 空き '.'、'/' で段区切り。続いて手番 b/w と持ち駒
const CH = { 1: 'l', 2: 'g', 3: 'e', 4: 'c', 5: 'h' };
export function toCode(p) {
  let s = '';
  for (let r = 0; r < 4; r++) {
    if (r) s += '/';
    for (let c = 0; c < 3; c++) {
      const pc = p.board[r * 3 + c];
      s += pc ? (pc.o === 0 ? CH[pc.t].toUpperCase() : CH[pc.t]) : '.';
    }
  }
  s += '_' + (p.turn === 0 ? 'b' : 'w') + '_';
  let h = '';
  for (let o = 0; o < 2; o++) for (let i = 0; i < 3; i++) for (let n = 0; n < p.hands[o][i]; n++) h += o === 0 ? CH[HAND_TYPES[i]].toUpperCase() : CH[HAND_TYPES[i]];
  return s + (h || '-');
}
export function fromCode(code) {
  const m = /^([lgechLGECH.]{3})\/([lgechLGECH.]{3})\/([lgechLGECH.]{3})\/([lgechLGECH.]{3})_([bw])_([gecGEC]*|-)$/.exec(code);
  if (!m) return null;
  const inv = { l: 1, g: 2, e: 3, c: 4, h: 5 };
  const board = [];
  for (let r = 0; r < 4; r++) for (const ch of m[r + 1]) board.push(ch === '.' ? null : { t: inv[ch.toLowerCase()], o: ch === ch.toUpperCase() ? 0 : 1 });
  const hands = [[0, 0, 0], [0, 0, 0]];
  if (m[6] !== '-') for (const ch of m[6]) hands[ch === ch.toUpperCase() ? 0 : 1][handIndex(inv[ch.toLowerCase()])]++;
  return { board, hands, turn: m[5] === 'b' ? 0 : 1 };
}
