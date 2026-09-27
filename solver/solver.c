// 3x4 ミニ将棋（どうぶつしょうぎのルール）の完全解析（後退解析）
//
// 局面は「手番側 = 自分(me)」に正規化する。自分は下（row 3 側）から上（row 0）へ進む。
// マス番号 s = row*3 + col。row 0 が自分の成り段（相手の陣）、row 3 が自分の陣。
//
// 終局の扱い（田中哲朗の解析と同じ「ライオンを取れる時は必ず取る」）:
//   - 手番側が相手ライオンを取れる        → 手番側の勝ち（あと1手）
//   - 取れず、相手ライオンが自分の陣(row 3) → 手番側の負け（あと0手）＝トライ成立
//
// val[idx]: 0..254 = 決着までの手数（偶数=手番側の負け、奇数=手番側の勝ち）、255 = 未確定→引き分け
//
// 出力: tb.bin（val 全体）, reach.bin（初期局面から到達できる局面のビットマップ）
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <omp.h>

enum { EMPTY = 0, L = 1, G = 2, E = 3, C = 4, H = 5, OP = 8 };
#define UNK 255

typedef struct { uint8_t b[12]; uint8_t hand[2][3]; } Pos;  // hand[0]=自分 hand[1]=相手、種類 0=G 1=E 2=C

static uint16_t att[6][12];    // att[type][s]  : 自分の駒が s から動けるマス
static uint16_t opatt[6][12];  // opatt[type][s]: 相手の駒が s から動けるマス

// ---- 番号付け ----
static int lmy[132], lop[132], lidx[12][12];
static int freeSq[132][10];
static int srank[1024], sunrank[11][252];
static int prank[7][729], punrank[27][90];
static int combo_g[27], combo_e[27], combo_c[27], combo_k[27], combo_nperm[27], combo_of[3][3][3];
static uint64_t combo_off[27], combo_size[27];
static uint64_t S;  // ライオン以外の配置の数
static uint64_t N;  // 全局面数

static const int typeOfDigit[3] = { G, E, C };
static int digitOfType(int t) { return t == G ? 0 : t == E ? 1 : 2; }  // C,H → 2

static int binom(int n, int k) {
    if (k < 0 || k > n) return 0;
    long r = 1;
    for (int i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return (int)r;
}

static void init_tables(void) {
    static const int dG[4][2] = { {-1,0},{1,0},{0,-1},{0,1} };
    static const int dE[4][2] = { {-1,-1},{-1,1},{1,-1},{1,1} };
    static const int dC[1][2] = { {-1,0} };
    static const int dH[6][2] = { {-1,-1},{-1,0},{-1,1},{0,-1},{0,1},{1,0} };
    static const int dL[8][2] = { {-1,-1},{-1,0},{-1,1},{0,-1},{0,1},{1,-1},{1,0},{1,1} };
    const int (*dirs[6])[2] = { 0, dL, dG, dE, dC, dH };
    const int nd[6] = { 0, 8, 4, 4, 1, 6 };
    for (int t = 1; t <= 5; t++)
        for (int s = 0; s < 12; s++) {
            int r = s / 3, c = s % 3;
            uint16_t m = 0, om = 0;
            for (int d = 0; d < nd[t]; d++) {
                int rr = r + dirs[t][d][0], cc = c + dirs[t][d][1];
                if (rr >= 0 && rr < 4 && cc >= 0 && cc < 3) m |= 1 << (rr * 3 + cc);
                rr = r - dirs[t][d][0]; cc = c - dirs[t][d][1];
                if (rr >= 0 && rr < 4 && cc >= 0 && cc < 3) om |= 1 << (rr * 3 + cc);
            }
            att[t][s] = m; opatt[t][s] = om;
        }

    int li = 0;
    for (int a = 0; a < 12; a++)
        for (int b = 0; b < 12; b++) {
            if (a == b) { lidx[a][b] = -1; continue; }
            lmy[li] = a; lop[li] = b; lidx[a][b] = li;
            int j = 0;
            for (int s = 0; s < 12; s++) if (s != a && s != b) freeSq[li][j++] = s;
            li++;
        }

    int cnt[11] = { 0 };
    for (int m = 0; m < 1024; m++) {
        int k = __builtin_popcount(m);
        srank[m] = cnt[k]; sunrank[k][cnt[k]] = m; cnt[k]++;
    }

    int ci = 0;
    for (int g = 0; g < 3; g++)
        for (int e = 0; e < 3; e++)
            for (int c = 0; c < 3; c++) {
                int k = g + e + c;
                combo_g[ci] = g; combo_e[ci] = e; combo_c[ci] = c; combo_k[ci] = k;
                combo_of[g][e][c] = ci;
                ci++;
            }
    int pcnt[27] = { 0 };
    for (int k = 0; k <= 6; k++) {
        int p3 = 1; for (int i = 0; i < k; i++) p3 *= 3;
        for (int code = 0; code < p3; code++) {
            int n[3] = { 0 }, x = code;
            for (int i = 0; i < k; i++) { n[x % 3]++; x /= 3; }
            if (n[0] > 2 || n[1] > 2 || n[2] > 2) { prank[k][code] = -1; continue; }
            int cj = combo_of[n[0]][n[1]][n[2]];
            prank[k][code] = pcnt[cj]; punrank[cj][pcnt[cj]] = code; pcnt[cj]++;
        }
    }
    uint64_t off = 0;
    for (int i = 0; i < 27; i++) {
        int g = combo_g[i], e = combo_e[i], c = combo_c[i], k = combo_k[i];
        combo_nperm[i] = pcnt[i];
        combo_size[i] = (uint64_t)binom(10, k) * pcnt[i] * (1u << k) * (1u << c) * (3 - g) * (3 - e) * (3 - c);
        combo_off[i] = off; off += combo_size[i];
    }
    S = off;
    N = S * 132;
}

static uint64_t rank_pos(const Pos *p) {
    int my = -1, op = -1;
    for (int s = 0; s < 12; s++) {
        if (p->b[s] == L) my = s; else if (p->b[s] == (L | OP)) op = s;
    }
    int li = lidx[my][op];
    const int *fs = freeSq[li];
    int mask = 0, code = 0, p3 = 1, owner = 0, promo = 0, k = 0, n[3] = { 0 };
    for (int j = 0; j < 10; j++) {
        int pc = p->b[fs[j]];
        if (!pc) continue;
        int t = pc & 7, d = digitOfType(t);
        mask |= 1 << j;
        code += d * p3; p3 *= 3;
        if (pc & OP) owner |= 1 << k;
        if (d == 2) { if (t == H) promo |= 1 << n[2]; }
        n[d]++; k++;
    }
    int ci = combo_of[n[0]][n[1]][n[2]];
    uint64_t r = (uint64_t)srank[mask] * combo_nperm[ci] + prank[k][code];
    r = ((r << k) | owner);
    r = ((r << n[2]) | promo);
    r = r * (3 - n[0]) + p->hand[0][0];
    r = r * (3 - n[1]) + p->hand[0][1];
    r = r * (3 - n[2]) + p->hand[0][2];
    return (uint64_t)li * S + combo_off[ci] + r;
}

static void unrank_pos(uint64_t idx, Pos *p) {
    memset(p, 0, sizeof *p);
    int li = (int)(idx / S);
    uint64_t r = idx % S;
    p->b[lmy[li]] = L; p->b[lop[li]] = L | OP;
    int ci = 26;
    for (int i = 0; i < 26; i++) if (r < combo_off[i + 1]) { ci = i; break; }
    r -= combo_off[ci];
    int g = combo_g[ci], e = combo_e[ci], c = combo_c[ci], k = combo_k[ci];
    int hc = (int)(r % (3 - c)); r /= (3 - c);
    int he = (int)(r % (3 - e)); r /= (3 - e);
    int hg = (int)(r % (3 - g)); r /= (3 - g);
    int promo = (int)(r & ((1u << c) - 1)); r >>= c;
    int owner = (int)(r & ((1u << k) - 1)); r >>= k;
    int perm = (int)(r % combo_nperm[ci]);
    int sub = (int)(r / combo_nperm[ci]);
    int mask = sunrank[k][sub], code = punrank[ci][perm];
    const int *fs = freeSq[li];
    int m = 0, cc = 0;
    for (int j = 0; j < 10; j++) {
        if (!(mask >> j & 1)) continue;
        int d = code % 3; code /= 3;
        int t = typeOfDigit[d];
        if (d == 2) { if (promo >> cc & 1) t = H; cc++; }
        if (owner >> m & 1) t |= OP;
        p->b[fs[j]] = (uint8_t)t;
        m++;
    }
    p->hand[0][0] = hg; p->hand[0][1] = he; p->hand[0][2] = hc;
    p->hand[1][0] = 2 - g - hg; p->hand[1][1] = 2 - e - he; p->hand[1][2] = 2 - c - hc;
}

static void flip(const Pos *a, Pos *o) {
    for (int s = 0; s < 12; s++) { int pc = a->b[s]; o->b[11 - s] = pc ? (uint8_t)(pc ^ OP) : 0; }
    for (int t = 0; t < 3; t++) { o->hand[0][t] = a->hand[1][t]; o->hand[1][t] = a->hand[0][t]; }
}

static int is_terminal(const Pos *p, int *win) {
    int op = -1;
    for (int s = 0; s < 12; s++) if (p->b[s] == (L | OP)) op = s;
    for (int s = 0; s < 12; s++) {
        int pc = p->b[s];
        if (pc && !(pc & OP) && (att[pc][s] >> op & 1)) { *win = 1; return 1; }
    }
    if (op / 3 == 3) { *win = 0; return 1; }
    return 0;
}

// 子局面（手を指して、相手手番に正規化したもの）の番号を列挙する。
static int gen_children(const Pos *p, uint64_t *out) {
    int n = 0;
    Pos q, f;
    for (int s = 0; s < 12; s++) {
        int pc = p->b[s];
        if (!pc || (pc & OP)) continue;
        uint16_t m = att[pc][s];
        while (m) {
            int t = __builtin_ctz(m); m &= m - 1;
            int cap = p->b[t];
            if (cap && !(cap & OP)) continue;
            q = *p;
            if (cap) {
                int ct = cap & 7;
                if (ct == L) continue;  // 終局局面からは呼ばれない
                q.hand[0][digitOfType(ct)]++;
            }
            q.b[t] = (pc == C && t / 3 == 0) ? H : (uint8_t)pc;
            q.b[s] = 0;
            flip(&q, &f); out[n++] = rank_pos(&f);
        }
    }
    for (int d = 0; d < 3; d++) {
        if (!p->hand[0][d]) continue;
        for (int t = 0; t < 12; t++) {
            if (p->b[t]) continue;
            q = *p; q.hand[0][d]--; q.b[t] = (uint8_t)typeOfDigit[d];
            flip(&q, &f); out[n++] = rank_pos(&f);
        }
    }
    return n;
}

// 親局面（相手が1手指す前の局面、相手手番に正規化）の番号を列挙する。
static int gen_preds(const Pos *x, uint64_t *out) {
    int n = 0;
    Pos q, q2, f;
    for (int t = 0; t < 12; t++) {
        int pc = x->b[t];
        if (!pc || !(pc & OP)) continue;
        int T = pc & 7;
        int from[12], before[12], nf = 0;
        if (T == C) {
            if (t / 3 >= 1 && t / 3 != 3) { from[nf] = t - 3; before[nf] = C; nf++; }
        } else {
            for (int s = 0; s < 12; s++)
                if (opatt[T][s] >> t & 1) { from[nf] = s; before[nf] = T; nf++; }
            if (T == H && t / 3 == 3) { from[nf] = t - 3; before[nf] = C; nf++; }
        }
        for (int i = 0; i < nf; i++) {
            int s = from[i];
            if (x->b[s]) continue;
            q = *x; q.b[s] = (uint8_t)(before[i] | OP); q.b[t] = 0;
            flip(&q, &f); out[n++] = rank_pos(&f);
            for (int d = 0; d < 3; d++) {
                if (!q.hand[1][d]) continue;
                q2 = q; q2.hand[1][d]--; q2.b[t] = (uint8_t)typeOfDigit[d];
                flip(&q2, &f); out[n++] = rank_pos(&f);
                if (d == 2) { q2.b[t] = H; flip(&q2, &f); out[n++] = rank_pos(&f); }
            }
        }
        if (T == G || T == E || T == C) {
            q = *x; q.b[t] = 0; q.hand[1][digitOfType(T)]++;
            flip(&q, &f); out[n++] = rank_pos(&f);
        }
    }
    return n;
}

static double now(void) { return (double)clock() / CLOCKS_PER_SEC; }
static double wall0;
static double wall(void) { return omp_get_wtime() - wall0; }

static Pos initial_pos(void) {
    Pos p; memset(&p, 0, sizeof p);
    p.b[0] = G | OP; p.b[1] = L | OP; p.b[2] = E | OP; p.b[4] = C | OP;
    p.b[7] = C; p.b[9] = E; p.b[10] = L; p.b[11] = G;
    return p;
}

#ifndef NO_MAIN
int main(int argc, char **argv) {
    (void)now;
    wall0 = omp_get_wtime();
    init_tables();
    printf("S=%llu N=%llu\n", (unsigned long long)S, (unsigned long long)N);

    // 番号付けの往復テスト
    {
        uint64_t x = 88172645463325252ull;
        for (int i = 0; i < 2000000; i++) {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            uint64_t idx = x % N;
            Pos p; unrank_pos(idx, &p);
            if (rank_pos(&p) != idx) { printf("rank mismatch at %llu\n", (unsigned long long)idx); return 1; }
        }
        printf("rank roundtrip ok\n");
        // 子局面の親一覧に元の局面が含まれるか
        long long checked = 0;
        for (int i = 0; i < 200000; i++) {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            uint64_t idx = x % N;
            Pos p; unrank_pos(idx, &p);
            int win;
            if (is_terminal(&p, &win)) continue;
            uint64_t ch[128], pr[512];
            int nc = gen_children(&p, ch);
            for (int k = 0; k < nc; k++) {
                Pos c; unrank_pos(ch[k], &c);
                int np = gen_preds(&c, pr), found = 0;
                for (int j = 0; j < np; j++) if (pr[j] == idx) found = 1;
                if (!found) { printf("pred missing: parent %llu child %llu\n", (unsigned long long)idx, (unsigned long long)ch[k]); return 1; }
                // 親一覧の各局面から見て、その子に c が含まれるか
                for (int j = 0; j < np; j++) {
                    Pos q; unrank_pos(pr[j], &q);
                    uint64_t ch2[128];
                    int nc2 = gen_children(&q, ch2), f2 = 0;
                    for (int m = 0; m < nc2; m++) if (ch2[m] == ch[k]) f2 = 1;
                    if (!f2) { printf("bogus pred %llu of %llu\n", (unsigned long long)pr[j], (unsigned long long)ch[k]); return 1; }
                }
                checked++;
            }
        }
        printf("move/unmove consistency ok (%lld edges)\n", checked);
        if (argc > 1 && !strcmp(argv[1], "test")) return 0;
        if (argc > 1 && !strcmp(argv[1], "vectors")) {
            // JS 版との照合用: 「局面コード 番号」を出力（engine.js の toCode と同じ書式）
            static const char CH[] = ".lgech";
            for (int i = 0; i < 3000; i++) {
                x ^= x << 13; x ^= x >> 7; x ^= x << 17;
                uint64_t idx = x % N;
                Pos p; unrank_pos(idx, &p);
                int asGote = i & 1;
                char s[64]; int n = 0;
                for (int r = 0; r < 4; r++) {
                    if (r) s[n++] = '/';
                    for (int c = 0; c < 3; c++) {
                        int sq = r * 3 + c, src = asGote ? 11 - sq : sq, pc = p.b[src];
                        if (!pc) { s[n++] = '.'; continue; }
                        int mine = !(pc & OP), sente = asGote ? !mine : mine;
                        char ch = CH[pc & 7];
                        s[n++] = sente ? (char)(ch - 32) : ch;
                    }
                }
                n += sprintf(s + n, "_%c_", asGote ? 'w' : 'b');
                int any = 0;
                for (int side = 0; side < 2; side++) {
                    int who = asGote ? 1 - side : side;  // side 0 = 先手
                    for (int t = 0; t < 3; t++)
                        for (int k = 0; k < p.hand[who][t]; k++) { char ch = "gec"[t]; s[n++] = side == 0 ? (char)(ch - 32) : ch; any = 1; }
                }
                if (!any) s[n++] = '-';
                s[n] = 0;
                printf("%s %llu\n", s, (unsigned long long)idx);
            }
            return 0;
        }
    }

    uint8_t *val = malloc(N);
    if (!val) { printf("alloc failed\n"); return 1; }

    long long n0 = 0, n1 = 0;
    #pragma omp parallel for schedule(dynamic, 1 << 16) reduction(+:n0, n1)
    for (long long i = 0; i < (long long)N; i++) {
        Pos p; unrank_pos((uint64_t)i, &p);
        int win;
        if (is_terminal(&p, &win)) { val[i] = win ? 1 : 0; if (win) n1++; else n0++; }
        else val[i] = UNK;
    }
    printf("[%.0fs] init: loss0=%lld win1=%lld\n", wall(), n0, n1);

    int maxlv = 0;
    // 偶数段（負け局面）→ 親を勝ちにする：負け局面から親をさかのぼる
    // 奇数段（勝ち局面）→ 負け局面を探す：未確定の局面を順に見て、全部の子が勝ち（相手の勝ち）なら負け
    //   （勝ち局面は数が多すぎるので、さかのぼると同じ親を何度も調べることになる）
    for (int lv = 0; lv < 254; lv++) {
        long long cnt = 0;
        if (!(lv & 1)) {
            #pragma omp parallel for schedule(dynamic, 1 << 16) reduction(+:cnt)
            for (long long i = 0; i < (long long)N; i++) {
                if (val[i] != lv) continue;
                Pos x; unrank_pos((uint64_t)i, &x);
                uint64_t pr[512];
                int np = gen_preds(&x, pr);
                for (int j = 0; j < np; j++) {
                    uint64_t q = pr[j];
                    if (val[q] != UNK) continue;
                    uint8_t exp = UNK;
                    if (__atomic_compare_exchange_n(&val[q], &exp, (uint8_t)(lv + 1), 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) cnt++;
                }
            }
        } else {
            #pragma omp parallel for schedule(dynamic, 1 << 16) reduction(+:cnt)
            for (long long i = 0; i < (long long)N; i++) {
                if (val[i] != UNK) continue;
                Pos r; unrank_pos((uint64_t)i, &r);
                uint64_t ch[128];
                int nc = gen_children(&r, ch), ok = 1, hit = 0;
                for (int k = 0; k < nc; k++) {
                    uint8_t v = val[ch[k]];
                    if (v == UNK || !(v & 1) || v > lv) { ok = 0; break; }
                    if (v == lv) hit = 1;
                }
                if (ok && hit) { val[i] = (uint8_t)(lv + 1); cnt++; }
            }
        }
        printf("[%.0fs] level %d -> %d: new %lld\n", wall(), lv, lv + 1, cnt);
        fflush(stdout);
        if (cnt) maxlv = lv + 1;
        if (lv >= 1 && cnt == 0) break;
    }
    printf("max level %d\n", maxlv);

    FILE *fp = fopen("tb.bin", "wb");
    fwrite(val, 1, N, fp); fclose(fp);
    printf("[%.0fs] saved tb.bin\n", wall());

    Pos ip = initial_pos();
    uint64_t iidx = rank_pos(&ip);
    printf("initial idx=%llu val=%d\n", (unsigned long long)iidx, val[iidx]);

    // 到達可能局面
    uint64_t nw = (N + 63) / 64;
    uint64_t *reach = calloc(nw, 8), *cur = calloc(nw, 8), *nxt = calloc(nw, 8);
    reach[iidx >> 6] |= 1ull << (iidx & 63);
    cur[iidx >> 6] |= 1ull << (iidx & 63);
    long long total = 1;
    for (int depth = 0;; depth++) {
        long long cnt = 0;
        #pragma omp parallel for schedule(dynamic, 1 << 12) reduction(+:cnt)
        for (long long w = 0; w < (long long)nw; w++) {
            uint64_t bits = cur[w];
            while (bits) {
                int bi = __builtin_ctzll(bits); bits &= bits - 1;
                uint64_t idx = (uint64_t)w * 64 + bi;
                Pos p; unrank_pos(idx, &p);
                int win;
                if (is_terminal(&p, &win)) continue;
                uint64_t ch[128];
                int nc = gen_children(&p, ch);
                for (int k = 0; k < nc; k++) {
                    uint64_t c = ch[k], m = 1ull << (c & 63);
                    if (reach[c >> 6] & m) continue;
                    uint64_t old = __atomic_fetch_or(&reach[c >> 6], m, __ATOMIC_RELAXED);
                    if (!(old & m)) { __atomic_fetch_or(&nxt[c >> 6], m, __ATOMIC_RELAXED); cnt++; }
                }
            }
        }
        total += cnt;
        if (cnt == 0) break;
        uint64_t *tmp = cur; cur = nxt; nxt = tmp;
        memset(nxt, 0, nw * 8);
        if (depth % 10 == 0) { printf("[%.0fs] bfs depth %d total %lld\n", wall(), depth + 1, total); fflush(stdout); }
    }
    printf("[%.0fs] reachable total %lld\n", wall(), total);

    long long rw = 0, rl = 0, rd = 0, rterm = 0;
    #pragma omp parallel for schedule(dynamic, 1 << 12) reduction(+:rw, rl, rd, rterm)
    for (long long w = 0; w < (long long)nw; w++) {
        uint64_t bits = reach[w];
        while (bits) {
            int bi = __builtin_ctzll(bits); bits &= bits - 1;
            uint64_t idx = (uint64_t)w * 64 + bi;
            uint8_t v = val[idx];
            if (v == UNK) rd++; else if (v & 1) rw++; else rl++;
            Pos p; unrank_pos(idx, &p);
            int win;
            if (is_terminal(&p, &win)) rterm++;
        }
    }
    printf("reachable: win %lld loss %lld draw %lld (terminal %lld, nonterminal %lld)\n", rw, rl, rd, rterm, total - rterm);

    fp = fopen("reach.bin", "wb");
    fwrite(reach, 8, nw, fp); fclose(fp);
    printf("[%.0fs] saved reach.bin\n", wall());
    return 0;
}
#endif
