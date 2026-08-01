"""
convert_hair_webp.py —— 把发型参考图（JPEG）批量转成 WebP，并修正 hairDatabase.json 的图片路径。

为什么做这一步：
  · WebP 体积通常只有 JPEG 的 1/3 ~ 1/2，能明显加快发型图片的加载速度（需求 4）。
  · 原 hairDatabase.json 里的 imageUrl 是绝对路径 "/public/images/hair/hNN.jpeg"，
    在 GitHub Pages（站点挂在 /ai-hairstyle-ar/ 子路径下）会 404。
    这里统一改成相对路径 "public/images/hair/hNN.webp"，本地与 Pages 都能正确加载。

用法：
  python tools/convert_hair_webp.py            # 转换 + 改写 JSON
  python tools/convert_hair_webp.py --quality 85
"""
import os
import re
import json
import argparse

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(PROJ, "public", "images", "hair")
DB_PATH = os.path.join(PROJ, "public", "models", "hair", "hairDatabase.json")


def to_webp(src, dst, quality):
    from PIL import Image
    im = Image.open(src)
    # 统一转 RGB（避免带 alpha 的 PNG 写入 webp 时变色）
    if im.mode in ("RGBA", "P", "LA"):
        im = im.convert("RGB")
    im.save(dst, "WEBP", quality=quality, method=4)
    return os.path.getsize(dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", type=int, default=82)
    args = ap.parse_args()

    converted = 0
    total_saved = 0
    for fn in sorted(os.listdir(IMG_DIR)):
        if not fn.lower().endswith((".jpeg", ".jpg")):
            continue
        base = os.path.splitext(fn)[0]
        src = os.path.join(IMG_DIR, fn)
        dst = os.path.join(IMG_DIR, base + ".webp")
        before = os.path.getsize(src)
        after = to_webp(src, dst, args.quality)
        converted += 1
        total_saved += (before - after)
        print(f"  {fn}  {before//1024}KB -> {after//1024}KB  ({dst})")

    # 改写 JSON：把 imageUrl 从绝对/旧扩展名修正为相对 .webp
    db = json.load(open(DB_PATH, encoding="utf-8"))
    fixed = 0
    for m in db.get("models", []):
        url = m.get("imageUrl")
        if not url:
            continue
        fname = os.path.basename(url)
        base = os.path.splitext(fname)[0]
        new_url = f"public/images/hair/{base}.webp"
        if url != new_url:
            m["imageUrl"] = new_url
            fixed += 1
    json.dump(db, open(DB_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open(DB_PATH, "a").write("\n")

    print(f"\n转换图片 {converted} 张，节省约 {total_saved//1024}KB")
    print(f"修正 imageUrl 路径 {fixed} 条 -> 相对路径 .webp")
    print("提示：原 .jpeg 文件保留作备份，如需清理可手动删除。")


if __name__ == "__main__":
    main()
