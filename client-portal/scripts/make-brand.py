#!/usr/bin/env python3
"""Build a client's portal branding from their logo (needs Pillow).

    python3 scripts/make-brand.py <username> <logo-file> --name "Bright Home Care" --short "Bright Home" \
        [--color "#283287"] [--icon-right 168] [--show-name]

Writes public/brands/<slug>/ (logo, app icons, manifest) and the entry in
netlify/functions/brands.json. The slug is random so client asset URLs are not guessable.
--color      brand accent (default: the logo's most common colour)
--icon-right crop the app icon to the logo's left part, up to this x (in the original file),
             e.g. to use just the house/leaf mark of a wide logo
--show-name  also print the client name next to the logo (for logos without the name in them)
Run `node scripts/deploy.mjs` afterwards.
"""
import argparse
import json
import secrets
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRANDS = ROOT / "netlify" / "functions" / "brands.json"


def content_box(im):
    """Bounding box of visible, non-white pixels."""
    w, h = im.size
    px = im.load()
    mask = Image.new("L", im.size, 0)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 40 and not (r > 242 and g > 242 and b > 242):
                mp[x, y] = 255
    return mask.getbbox()


def trimmed(im, pad_ratio=0.02):
    box = content_box(im)
    im = im.crop(box)
    pad = int(max(im.size) * pad_ratio)
    out = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), (0, 0, 0, 0))
    out.paste(im, (pad, pad))
    return out


def main_color(im):
    c = Counter()
    for r, g, b, a in im.getdata():
        if a < 250 or (r > 235 and g > 235 and b > 235):
            continue
        c[(r, g, b)] += 1
    r, g, b = c.most_common(1)[0][0]
    return f"#{r:02X}{g:02X}{b:02X}"


def square_icon(mark, size, fill, path, bg=(255, 255, 255, 255)):
    canvas = Image.new("RGBA", (size * 4, size * 4), bg)
    scale = size * 4 * fill / max(mark.size)  # grow small marks too, not just shrink
    m = mark.resize((max(1, round(mark.width * scale)), max(1, round(mark.height * scale))), Image.LANCZOS)
    canvas.alpha_composite(m, ((canvas.width - m.width) // 2, (canvas.height - m.height) // 2))
    canvas.resize((size, size), Image.LANCZOS).convert("RGB").save(path, optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("logo")
    ap.add_argument("--name", required=True)
    ap.add_argument("--short", required=True)
    ap.add_argument("--color")
    ap.add_argument("--icon-right", type=int)
    ap.add_argument("--show-name", action="store_true")
    a = ap.parse_args()

    brands = json.loads(BRANDS.read_text()) if BRANDS.exists() else {}
    entry = brands.get(a.username, {})
    slug = entry.get("slug") or secrets.token_hex(5)
    out = ROOT / "public" / "brands" / slug
    out.mkdir(parents=True, exist_ok=True)

    src = Image.open(a.logo).convert("RGBA")
    logo = trimmed(src)
    color = (a.color or main_color(logo)).upper()

    # Header logo: crisp on retina at ~48px tall.
    big = logo.copy()
    big.thumbnail((900, 192), Image.LANCZOS)
    big.save(out / "logo.png", optimize=True)

    mark_src = src.crop((0, 0, a.icon_right, src.height)) if a.icon_right else src
    mark = trimmed(mark_src, 0)
    square_icon(mark, 192, 0.72, out / "icon-192.png")
    square_icon(mark, 512, 0.72, out / "icon-512.png")
    square_icon(mark, 512, 0.56, out / "icon-maskable-512.png")
    square_icon(mark, 180, 0.74, out / "apple-touch-icon.png")

    manifest = {
        "name": a.name,
        "short_name": a.short,
        "description": f"{a.name} leads, powered by LeadThru.",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "portrait",
        "background_color": "#ffffff",
        "theme_color": "#040604",
        "icons": [
            {"src": f"/brands/{slug}/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": f"/brands/{slug}/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": f"/brands/{slug}/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    (out / "manifest.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")

    brands[a.username] = {
        "slug": slug,
        "name": a.name,
        "short": a.short,
        "color": color,
        "showName": bool(a.show_name),
        "logoRatio": round(big.width / big.height, 3),
    }
    BRANDS.write_text(json.dumps(dict(sorted(brands.items())), indent=2) + "\n")
    print(f"{a.username}: slug {slug}, colour {color}, logo {big.size}")


if __name__ == "__main__":
    main()
