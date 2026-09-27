// C 版と JS 版の局面番号の照合: node test_rank.mjs ../solver/vectors.txt
import { readFileSync } from 'node:fs';
import * as R from './engine.js';
const lines = readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
let bad = 0;
for (const ln of lines) {
  const [code, idx] = ln.split(' ');
  const p = R.fromCode(code);
  const got = p ? R.rankPos(p) : 'parse';
  if (String(got) !== idx) { if (bad++ < 5) console.log('mismatch', code, idx, got); continue; }
  if (R.toCode(p) !== code) { if (bad++ < 5) console.log('code roundtrip', code, R.toCode(p)); }
}
console.log(`${lines.length} vectors, ${bad} mismatches`);
console.log('initial', R.rankPos(R.initialPosition()), 'N', R.N_POS);
