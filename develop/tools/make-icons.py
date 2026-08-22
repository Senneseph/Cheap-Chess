#!/usr/bin/env python3
"""Generate Cheap Chess PWA icons (192/512/180) with PIL + DejaVu chess glyphs."""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'app', 'icons'))
os.makedirs(OUT, exist_ok=True)

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
ACCENT = (11, 107, 203, 255)      # #0b6bcb
BG_TOP = (22, 33, 46, 255)        # #16212e
BG_BOTTOM = (14, 18, 23, 255)     # #0e1217
PIECE_LIGHT = (247, 245, 238, 255)


def draw_icon(size):
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    # vertical gradient
    for y in range(size):
        t = y / size
        d.line([(0, y), (size, y)], fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)) + (255,))
    # knight glyph, centered, with a subtle accent underlay
    glyph = "\u265e"  # black knight
    font = ImageFont.truetype(FONT, int(size * 0.72))
    bbox = d.textbbox((0, 0), glyph, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    # soft accent glow
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([size*0.18, size*0.18, size*0.82, size*0.82], fill=ACCENT)
    glow = glow.filter(ImageFilter_GaussianBlur(size * 0.06))
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)
    d.text((x, y), glyph, font=font, fill=PIECE_LIGHT)
    # rounded corners + border
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([2, 2, size - 2, size - 2], radius=int(size * 0.18), fill=255)
    img.putalpha(mask)
    # accent ring
    ring = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.rounded_rectangle([4, 4, size - 4, size - 4], radius=int(size * 0.17), outline=ACCENT, width=max(2, size // 96))
    img = Image.alpha_composite(img, ring)
    return img


try:
    from PIL import ImageFilter
    ImageFilter_GaussianBlur = ImageFilter.GaussianBlur
except Exception:  # pragma: no cover
    ImageFilter_GaussianBlur = lambda r: ImageFilter.GaussianBlur(r)

for size in (192, 512, 180):
    icon = draw_icon(size)
    path = os.path.join(OUT, f"icon-{size}.png")
    icon.save(path)
    print("wrote", path)
