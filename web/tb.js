// 解析データの読み込み
//
// data/index.json : { blockBits, packs: [ファイル名...], mirror: bool, noData: 254 }
// data/index.bin  : ブロックごとに uint32 × 3（pack 番号, pack 内の位置, 長さ）
// data/packN.bin  : deflate-raw で圧縮したブロックを並べたもの（Range で必要な分だけ取得）
//
// 値: 0..253 = 決着までの手数（偶数=手番側の負け、奇数=手番側の勝ち）、255 = 引き分け、254 = データなし

import { rankPos, mirrorPos } from './engine.js';

export const DRAW = 255, NO_DATA = 254;
const MAX_PARALLEL = 6;
const RETRY_DELAYS = [300, 1000, 2500];

export class Tablebase {
  constructor(base) {
    this.base = base;
    this.blocks = new Map();
    this.ready = this.#load();
  }

  async #load() {
    const get = async (name) => {
      const res = await fetch(this.base + name);
      if (!res.ok) throw new Error('解析データを読み込めませんでした（' + name + ' ' + res.status + '）');
      return res;
    };
    const meta = await (await get('index.json')).json();
    const idx = new Uint32Array(await (await get('index.bin')).arrayBuffer());
    this.meta = meta;
    this.index = idx;
    this.blockSize = 2 ** meta.blockBits;
  }

  // 同時に取りに行く数を絞る（一度に大量に投げると通信エラーになりやすい）
  #active = 0;
  #waiting = [];
  async #limited(fn) {
    if (this.#active >= MAX_PARALLEL) await new Promise((r) => this.#waiting.push(r));
    this.#active++;
    try { return await fn(); } finally {
      this.#active--;
      const next = this.#waiting.shift();
      if (next) next();
    }
  }

  async #fetchBlock(pack, off, len) {
    const res = await fetch(this.base + this.meta.packs[pack], { headers: { Range: `bytes=${off}-${off + len - 1}` } });
    if (!res.ok) throw new Error('解析データの取得に失敗しました（' + res.status + '）');
    let buf = new Uint8Array(await res.arrayBuffer());
    // Range を無視してファイル全体が返ってきた場合
    if (res.status === 200 && buf.length !== len) buf = buf.subarray(off, off + len);
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }

  #block(b) {
    let pr = this.blocks.get(b);
    if (pr) return pr;
    pr = (async () => {
      const pack = this.index[b * 3], off = this.index[b * 3 + 1], len = this.index[b * 3 + 2];
      if (len === 0) return null;
      // 失敗したら間隔をあけて取り直す
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.#limited(() => this.#fetchBlock(pack, off, len));
        } catch (e) {
          if (attempt >= RETRY_DELAYS.length) throw new Error('解析データを取得できませんでした（通信エラー）');
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        }
      }
    })();
    pr.catch(() => this.blocks.delete(b));
    this.blocks.set(b, pr);
    return pr;
  }

  // 目次の読み込みに失敗していたら読み直す
  async #ensureReady() {
    try { await this.ready; } catch {
      this.ready = this.#load();
      await this.ready;
    }
  }

  async byIndex(i) {
    await this.#ensureReady();
    const b = Math.floor(i / this.blockSize);
    const data = await this.#block(b);
    return data ? data[i - b * this.blockSize] : NO_DATA;
  }

  // 局面の値（手番側から見た値）
  async value(p) {
    const i = rankPos(p);
    if (i < 0) return NO_DATA;
    await this.#ensureReady();
    if (this.meta.mirror) {
      const j = rankPos(mirrorPos(p));
      return this.byIndex(Math.min(i, j));
    }
    return this.byIndex(i);
  }
}

// 手番側から見た値 → 表示用
export function describe(v) {
  if (v === NO_DATA) return { kind: 'none', plies: null };
  if (v === DRAW) return { kind: 'draw', plies: null };
  return { kind: v % 2 === 1 ? 'win' : 'loss', plies: v };
}
