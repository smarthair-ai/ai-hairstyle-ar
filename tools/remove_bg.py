#!/usr/bin/env python3
"""
remove_bg.py —— 发型照片背景自动移除 + 边缘羽化（优化版）

对 public/images/hair/ 中的发型照片做：
1. 检测背景主色（四角+边缘采样）
2. 全像素颜色容差去背（向量化，秒级完成）
3. 形态学闭运算修补头发内部空洞
4. Alpha 通道高斯模糊羽化
5. 输出透明 PNG

用法：
  python tools/remove_bg.py                    # 处理全部
  python tools/remove_bg.py --input h01.webp   # 处理单张
  python tools/remove_bg.py --tolerance 35     # 调整颜色容差（默认32）
  python tools/remove_bg.py --feather 4        # 羽化半径像素（默认4）
"""

import argparse
import os
import sys
import json
import math
from collections import deque

from PIL import Image, ImageFilter, ImageDraw, ImageChops


def get_dominant_bg_color(img, sample_border_px=8):
    """从图片四角和边缘区域采样，找出最可能的背景色。"""
    w, h = img.size
    samples = []

    corner_size = min(w, h) // 6
    corners = [
        (0, 0, corner_size, corner_size),
        (max(0, w - corner_size), 0, corner_size, corner_size),
        (0, max(0, h - corner_size), corner_size, corner_size),
        (max(0, w - corner_size), max(0, h - corner_size), corner_size, corner_size),
    ]
    for x0, y0, cw, ch in corners:
        region = img.crop((x0, y0, x0 + cw, y0 + ch))
        samples.extend(list(region.getdata()))

    if w > sample_border_px * 2:
        top_strip = img.crop((sample_border_px, 0, w - sample_border_px, sample_border_px))
        bot_strip = img.crop((sample_border_px, h - sample_border_px, w - sample_border_px, h))
        samples.extend(list(top_strip.getdata()))
        samples.extend(list(bot_strip.getdata()))

    if not samples:
        return (240, 240, 240)

    rs = sorted(s[0] for s in samples)
    gs = sorted(s[1] for s in samples)
    bs = sorted(s[2] for s in samples)
    mid = len(samples) // 2
    return (rs[mid], gs[mid], bs[mid])


def remove_background_fast(img, tolerance=32, bg_color=None):
    """
    快速背景移除：逐像素颜色距离判断（无 BFS），向量化友好。
    返回 RGBA 图片。
    """
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    if bg_color is None:
        bg_color = get_dominant_bg_color(img)

    w, h = img.size
    data = img.load()
    tol_sq = tolerance * tolerance

    # 直接遍历所有像素（PIL 的 pixel access 在 C 层，比纯 Python BFS 快得多）
    for y in range(h):
        for x in range(w):
            px = data[x, y]
            dist = (int(px[0]) - bg_color[0]) ** 2 + \
                   (int(px[1]) - bg_color[1]) ** 2 + \
                   (int(px[2]) - bg_color[2]) ** 2
            if dist <= tol_sq:
                data[x, y] = (px[0], px[1], px[2], 0)

    return img


def fix_holes_morphology(img, max_hole_size=500):
    """
    简单形态学闭运算：填补头发内部的小面积背景空洞。
    用 flood fill 检测连通区域，小区域反转为不透明。
    """
    w, h = img.size
    data = img.load()
    visited = [[False] * w for _ in range(h)]

    def fill(x0, y0, target_alpha):
        """返回填充区域的像素数"""
        count = 0
        q = deque([(x0, y0)])
        while q:
            x, y = q.popleft()
            if x < 0 or x >= w or y < 0 or y >= h:
                continue
            if visited[y][x]:
                continue
            px = data[x, y]
            if px[3] != target_alpha:
                continue
            visited[y][x] = True
            count += 1
            q.append((x + 1, y)); q.append((x - 1, y))
            q.append((x, y + 1)); q.append((x, y - 1))
        return count

    # 找出所有透明连通区域（背景残留）
    holes = []
    for y in range(h):
        for x in range(w):
            if not visited[y][x] and data[x, y][3] == 0:
                size = fill(x, y, 0)
                if 0 < size <= max_hole_size:
                    holes.append((x, y, size))

    # 填补小空洞：用周围非透明色的平均值
    for hx, hy, _ in holes:
        q = deque([(hx, hy)])
        filled = set()
        while q:
            x, y = q.popleft()
            if x < 0 or x >= w or y < 0 or y >= h:
                continue
            if (x, y) in filled:
                continue
            if data[x, y][3] != 0:
                continue
            filled.add((x, y))
            # 取邻近非透明像素的平均色
            colors = []
            for dx, dy in [(1,0),(-1,0),(0,1),(0,-1)]:
                nx2, ny2 = x+dx, y+dy
                if 0 <= nx2 < w and 0 <= ny2 < h and data[nx2, ny2][3] > 128:
                    colors.append(data[nx2, ny2][:3])
            if colors:
                avg = tuple(sum(c)//len(colors) for c in zip(*colors))
                data[x, y] = (avg[0], avg[1], avg[2], 255)
            else:
                data[x, y] = (255, 255, 255, 0)  # 无邻居可参考，保持透明
            q.append((x+1,y)); q.append((x-1,y)); q.append((x,y+1)); q.append((x,y-1))

    return img


def feather_edges_alpha(img, radius=4):
    """对 Alpha 通道做高斯模糊，实现边缘羽化。"""
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    if radius <= 0:
        return img
    r, g, b, a = img.split()
    a_blurred = a.filter(ImageFilter.GaussianBlur(radius=radius))
    return Image.merge('RGBA', (r, g, b, a_blurred))


def process_image(input_path, output_path, tolerance=32, feather_radius=4,
                   fix_holes=True, max_hole_size=500):
    """处理单张图片：去背 → 补洞 → 羽化 → 输出 PNG。"""
    basename = os.path.basename(input_path)
    print(f'  处理: {basename}', end=' ', flush=True)

    img = Image.open(input_path)
    orig_mode = img.mode
    print(f'[{orig_mode} {img.size[0]}x{img.size[1]}]', end=' ', flush=True)

    # 1. 去背景
    img = remove_background_fast(img, tolerance=tolerance)

    # 2. 修补头发内部空洞
    if fix_holes:
        img = fix_holes_morphology(img, max_hole_size=max_hole_size)

    # 3. 羽化
    if feather_radius > 0:
        img = feather_edges_alpha(img, radius=feather_radius)

    # 4. 输出 PNG
    img.save(output_path, 'PNG')
    size_kb = os.path.getsize(output_path) / 1024
    print(f'→ {os.path.basename(output_path)} ({size_kb:.0f}KB)', flush=True)
    return output_path


def main():
    parser = argparse.ArgumentParser(description='发型照片背景移除 + 羽化')
    parser.add_argument('--input', '-i', help='单张图片路径（默认处理全部）')
    parser.add_argument('--output-dir', '-o', default=None, help='输出目录（默认覆盖原图目录）')
    parser.add_argument('--tolerance', '-t', type=int, default=32, help='颜色容差 0-100（默认32）')
    parser.add_argument('--feather', '-f', type=int, default=4, help='羽化半径 px（默认4，0=不羽化）')
    parser.add_argument('--no-fix-holes', action='store_true', help='跳过空洞修补')
    parser.add_argument('--update-json', action='store_true', help='同时更新 hairDatabase.json 的 imageUrl 为 .png')
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    img_dir = os.path.join(base_dir, 'public', 'images', 'hair')
    out_dir = args.output_dir or img_dir
    os.makedirs(out_dir, exist_ok=True)

    if args.input:
        files = [args.input]
    else:
        exts = {'.jpg', '.jpeg', '.webp', '.bmp'}
        files = [
            os.path.join(img_dir, f) for f in sorted(os.listdir(img_dir))
            if os.path.splitext(f)[1].lower() in exts
        ]

    if not files:
        print('没有找到需要处理的图片。')
        return

    print(f'=== 发型照片去背 + 羽化 ===')
    print(f'容差={args.tolerance}  羽化={args.feather}px  补洞={not args.no_fix_holes}')
    print(f'输出→{out_dir}\n')

    converted = []  # (original_basename, png_name)

    for fpath in files:
        in_path = fpath if os.path.isabs(fpath) else os.path.abspath(fpath)
        base = os.path.splitext(os.path.basename(in_path))[0]
        out_name = f'{base}.png'
        out_path = os.path.join(out_dir, out_name)

        try:
            process_image(in_path, out_path,
                           tolerance=args.tolerance,
                           feather_radius=args.feather,
                           fix_holes=not args.no_fix_holes)
            converted.append((os.path.basename(in_path), out_name))
        except Exception as e:
            print(f'  ✗ {os.path.basename(fpath)}: {e}')

    # 更新 JSON
    if args.update_json and converted:
        db_path = os.path.join(base_dir, 'public', 'models', 'hair', 'hairDatabase.json')
        if os.path.exists(db_path):
            with open(db_path, 'r', encoding='utf-8') as f:
                db = json.load(f)
            to_png = dict(converted)
            updated = 0
            for m in db['models']:
                url = m.get('imageUrl', '')
                if url:
                    url_basename = os.path.basename(url)
                    if url_basename in to_png:
                        new_url = f'images/hair/{to_png[url_basename]}'
                        m['imageUrl'] = new_url
                        updated += 1
                        print(f'  JSON: {url_basename} → {to_png[url_basename]}')
            with open(db_path, 'w', encoding='utf-8') as f:
                json.dump(db, f, ensure_ascii=False, indent=2)
            print(f'\n已更新 {updated} 条 imageUrl → .png')

    print(f'\n完成！处理了 {len(converted)} 张图片。')


if __name__ == '__main__':
    main()
