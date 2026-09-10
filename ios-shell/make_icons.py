#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 iOS 图标（零依赖，只用标准库 zlib + struct 手写 PNG）。

产物：
    ios-shell/AIChat/Resources/AppIcon60x60@2x.png   120x120
    ios-shell/AIChat/Resources/AppIcon60x60@3x.png   180x180

要求（App Store / iOS 的硬性规定）：
    - 正方形
    - 完全不透明（不许有透明像素，否则 TrollStore 装上图标会变黑块）
    - 全铺满，不要自己画圆角（系统会裁）

设计：深色渐变底 + 绿色对话气泡 + 三个点。
用 4x 超采样做抗锯齿。
"""

import os
import struct
import zlib

SS = 4  # 超采样倍数

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "AIChat", "Resources")


# ---------------------------------------------------------------- 几何
def in_round_rect(x, y, x0, y0, x1, y1, r):
    """点是否落在圆角矩形内"""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def in_triangle(px, py, a, b, c):
    """点是否落在三角形内（同号法）"""
    def side(p1, p2, p3):
        return ((p1[0] - p3[0]) * (p2[1] - p3[1])
                - (p2[0] - p3[0]) * (p1[1] - p3[1]))

    d1 = side((px, py), a, b)
    d2 = side((px, py), b, c)
    d3 = side((px, py), c, a)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def in_circle(x, y, cx, cy, r):
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- 绘制
def sample(u, v):
    """u,v ∈ [0,1]，返回 (r,g,b) —— 单点颜色（未抗锯齿）"""
    # 背景：左上偏亮的深蓝灰 -> 右下近黑
    t = (u * 0.45 + v * 0.55)
    bg = (int(lerp(30, 10, t)),
          int(lerp(36, 13, t)),
          int(lerp(52, 20, t)))

    GREEN = (7, 193, 96)      # #07c160，和页面主色一致
    DARK = (11, 14, 20)

    # 对话气泡主体
    if in_round_rect(u, v, 0.165, 0.195, 0.835, 0.635, 0.145):
        # 气泡内三个点（挖空）
        cy = 0.415
        for cx in (0.335, 0.500, 0.665):
            if in_circle(u, v, cx, cy, 0.043):
                return DARK
        return GREEN

    # 气泡尾巴
    tail = ((0.300, 0.575), (0.255, 0.805), (0.470, 0.615))
    if in_triangle(u, v, tail[0], tail[1], tail[2]):
        return GREEN

    return bg


def render(size):
    """渲染成 size x size 的 RGB 像素行"""
    rows = []
    step = 1.0 / (size * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            # SS x SS 超采样
            for sy in range(SS):
                v = (py * SS + sy + 0.5) * step
                for sx in range(SS):
                    u = (px * SS + sx + 0.5) * step
                    cr, cg, cb = sample(u, v)
                    r += cr
                    g += cg
                    b += cb
            n = SS * SS
            row += bytes((r // n, g // n, b // n))
        rows.append(bytes(row))
    return rows


# ---------------------------------------------------------------- PNG
def write_png(path, size, rows):
    """rows: 每行 size*3 字节的 RGB；写成 8-bit RGB PNG"""
    raw = b"".join(b"\x00" + r for r in rows)   # 每行前面加 filter type 0
    comp = zlib.compress(raw, 9)

    def chunk(typ, data):
        out = struct.pack(">I", len(data)) + typ + data
        out += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return out

    png = b"\x89PNG\r\n\x1a\n"
    # color type 2 = RGB（无 alpha 通道，从格式上就杜绝透明）
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)


# ---------------------------------------------------------------- 校验
def verify(path, size):
    """回读 PNG，确认尺寸、方形、无 alpha 通道"""
    with open(path, "rb") as f:
        data = f.read()

    assert data[:8] == b"\x89PNG\r\n\x1a\n", "PNG 头错误"
    w, h, depth, ctype = struct.unpack(">IIBB", data[16:26])

    if (w, h) != (size, size):
        raise SystemExit("[X] %s bad size: %dx%d" % (path, w, h))
    if depth != 8:
        raise SystemExit("[X] %s bit depth != 8" % path)
    if ctype != 2:
        raise SystemExit("[X] %s color type != RGB(2), may have alpha" % path)

    kb = len(data) / 1024.0
    print("  [OK] %-24s %dx%d   RGB no-alpha   %.1f KB"
          % (os.path.basename(path), w, h, kb))


# ---------------------------------------------------------------- main
def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    targets = [
        ("AppIcon60x60@2x.png", 120),
        ("AppIcon60x60@3x.png", 180),
    ]

    print("\n生成图标 -> %s\n" % OUT_DIR)
    for name, size in targets:
        path = os.path.join(OUT_DIR, name)
        write_png(path, size, render(size))
        verify(path, size)

    print("\n完成：图标全铺满、正方形、无透明通道，系统会自动裁圆角。\n")


if __name__ == "__main__":
    main()
