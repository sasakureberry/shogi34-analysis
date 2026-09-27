// Web 用データの下ごしらえ: tb.bin + reach.bin → web.bin
//   必要な局面だけ値を残し、それ以外は 254（データなし）にする。
//   必要な局面 = 到達可能な局面と、そのうちライオンを取れる局面の子局面（検討画面では取らない手も並ぶため）。
//   左右反転した局面は評価が同じなので、番号の小さい方（代表）だけに値を置く。
#define NO_MAIN
#include "solver.c"

#define NO_DATA 254

static uint64_t canon(const Pos *p) {
    Pos m;
    for (int s = 0; s < 12; s++) m.b[(s / 3) * 3 + 2 - s % 3] = p->b[s];
    memcpy(m.hand, p->hand, sizeof m.hand);
    uint64_t a = rank_pos(p), b = rank_pos(&m);
    return a < b ? a : b;
}

int main(void) {
    wall0 = omp_get_wtime();
    init_tables();
    uint64_t nw = (N + 63) / 64;
    uint8_t *val = malloc(N);
    uint64_t *reach = malloc(nw * 8), *need = calloc(nw, 8);
    FILE *fp = fopen("tb.bin", "rb"); fread(val, 1, N, fp); fclose(fp);
    fp = fopen("reach.bin", "rb"); fread(reach, 8, nw, fp); fclose(fp);
    printf("[%.0fs] loaded\n", wall());

    #pragma omp parallel for schedule(dynamic, 1 << 12)
    for (long long w = 0; w < (long long)nw; w++) {
        uint64_t bits = reach[w];
        while (bits) {
            int bi = __builtin_ctzll(bits); bits &= bits - 1;
            uint64_t idx = (uint64_t)w * 64 + bi;
            Pos p; unrank_pos(idx, &p);
            uint64_t c = canon(&p);
            __atomic_fetch_or(&need[c >> 6], 1ull << (c & 63), __ATOMIC_RELAXED);
        }
    }
    {
        long long cc = 0;
        #pragma omp parallel for reduction(+:cc)
        for (long long w = 0; w < (long long)nw; w++) cc += __builtin_popcountll(need[w]);
        printf("[%.0fs] reachable, mirror merged: %lld\n", wall(), cc);
    }
    #pragma omp parallel for schedule(dynamic, 1 << 12)
    for (long long w = 0; w < (long long)nw; w++) {
        uint64_t bits = reach[w];
        while (bits) {
            int bi = __builtin_ctzll(bits); bits &= bits - 1;
            uint64_t idx = (uint64_t)w * 64 + bi;
            Pos p; unrank_pos(idx, &p);
            int win;
            if (is_terminal(&p, &win) && win) {
                uint64_t ch[128];
                int nc = gen_children(&p, ch);
                for (int k = 0; k < nc; k++) {
                    Pos q; unrank_pos(ch[k], &q);
                    uint64_t cc = canon(&q);
                    __atomic_fetch_or(&need[cc >> 6], 1ull << (cc & 63), __ATOMIC_RELAXED);
                }
            }
        }
    }
    printf("[%.0fs] need marked\n", wall());

    long long kept = 0, hist[256] = { 0 };
    #pragma omp parallel for schedule(static) reduction(+:kept)
    for (long long i = 0; i < (long long)N; i++) {
        if (need[i >> 6] >> (i & 63) & 1) kept++;
        else val[i] = NO_DATA;
    }
    for (long long i = 0; i < (long long)N; i++) if (val[i] != NO_DATA) hist[val[i]]++;
    printf("[%.0fs] kept %lld positions\n", wall(), kept);
    for (int v = 0; v < 256; v++) if (hist[v]) printf("  val %3d: %lld\n", v, hist[v]);

    fp = fopen("web.bin", "wb"); fwrite(val, 1, N, fp); fclose(fp);
    printf("[%.0fs] saved web.bin\n", wall());
    return 0;
}
