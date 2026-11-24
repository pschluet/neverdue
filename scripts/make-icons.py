#!/usr/bin/env python3
"""One-off: renders the app icon PNGs (matches app/public/icon.svg). Pure stdlib."""
import math, struct, sys, zlib

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def render(size, rounded):
    s = size / 512
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            px, py = (x + .5) / s, (y + .5) / s
            t = (px + py) / 1024
            r, g, b = (int(90 + (10 - 90) * t), int(200 + (132 - 200) * t), int(250 + (255 - 250) * t))
            a = 255
            if rounded:  # rounded-square mask, 115px radius
                cx, cy = min(max(px, 115), 397), min(max(py, 115), 397)
                d = math.hypot(px - cx, py - cy) - 115
                a = int(255 * max(0, min(1, .5 - d * s)))
            ring = abs(math.hypot(px - 256, py - 256) - 150) - 17
            chk = min(seg_dist(px, py, 190, 262, 238, 310), seg_dist(px, py, 238, 310, 326, 206)) - 20
            w = max(max(0, min(1, .5 - ring * s)), max(0, min(1, .5 - chk * s)))
            r, g, b = (int(c + (255 - c) * w * .95) for c in (r, g, b))
            row += bytes((r, g, b, a))
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

out = sys.argv[1]
for name, size, rounded in (('icon-192.png', 192, True), ('icon-512.png', 512, False), ('apple-touch-icon.png', 180, False)):
    open(f'{out}/{name}', 'wb').write(render(size, rounded))
