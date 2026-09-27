# web.bin → web/data/（index.json, index.bin, packN.bin）
# ブロック（2^BLOCK_BITS 局面）ごとに deflate-raw で圧縮し、1ファイル PACK_LIMIT 以下にまとめる。
# 全部が「データなし」のブロックは長さ 0 にして、ファイルに入れない。
import json, os, struct, sys, zlib

BLOCK_BITS = 16
PACK_LIMIT = 24 * 1024 * 1024  # Cloudflare Pages の1ファイル上限（25MiB）より小さく
NO_DATA = 254

src = sys.argv[1] if len(sys.argv) > 1 else 'web.bin'
out = sys.argv[2] if len(sys.argv) > 2 else '../web/data'
os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    if f.startswith('pack') or f.startswith('index'):
        os.remove(os.path.join(out, f))

bs = 1 << BLOCK_BITS
size = os.path.getsize(src)
nblocks = (size + bs - 1) // bs
index = bytearray()
packs, cur, cur_len = [], None, 0
total = 0
empty = bytes([NO_DATA]) * bs
with open(src, 'rb') as f:
    for b in range(nblocks):
        raw = f.read(bs)
        if raw == empty[:len(raw)]:
            index += struct.pack('<III', 0, 0, 0)
            continue
        co = zlib.compressobj(9, zlib.DEFLATED, -15, 9)
        comp = co.compress(raw) + co.flush()
        if cur is None or cur_len + len(comp) > PACK_LIMIT:
            if cur: cur.close()
            name = f'pack{len(packs):03d}.bin'
            packs.append(name)
            cur = open(os.path.join(out, name), 'wb')
            cur_len = 0
        index += struct.pack('<III', len(packs) - 1, cur_len, len(comp))
        cur.write(comp)
        cur_len += len(comp)
        total += len(comp)
        if b % 2000 == 0:
            print(f'block {b}/{nblocks} total {total / 1e6:.1f} MB', flush=True)
if cur: cur.close()
with open(os.path.join(out, 'index.bin'), 'wb') as f:
    f.write(index)
with open(os.path.join(out, 'index.json'), 'w') as f:
    json.dump({'blockBits': BLOCK_BITS, 'packs': packs, 'mirror': True, 'noData': NO_DATA, 'positions': size}, f)
print(f'{len(packs)} packs, {total / 1e6:.1f} MB compressed, index {len(index) / 1e3:.0f} KB')
