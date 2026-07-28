#!/usr/bin/env python3
"""Generate the PWA icon set from the same mark as public/favicon.svg.

The mark: three lines of text, the first two still there, the third gone but for the
rule that shows where it was. That is the product in one glyph.

Run: python3 scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (18, 20, 23, 255)  # --paper dark
INK = (237, 235, 230, 255)  # --text-strong dark
RULE = (95, 201, 188, 255)  # --accent dark

# Drawn at 4x then downsampled: PIL has no anti-aliased rounded rectangle.
SS = 4


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def render(size: int, maskable: bool) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # A maskable icon must keep its content inside the 80% safe zone, so the background
    # is a full bleed square and the mark is scaled down.
    if maskable:
        d.rectangle([0, 0, s, s], fill=BG)
        inset = s * 0.20
        content = s - inset * 2
    else:
        rounded(d, [0, 0, s - 1, s - 1], radius=s * 0.22, fill=BG)
        inset = s * 0.22
        content = s - inset * 2

    bar_h = content * 0.115
    gap = content * 0.175
    r = bar_h / 2
    x0 = inset
    y = inset + content * 0.11

    # line 1: full width, remembered
    rounded(d, [x0, y, x0 + content, y + bar_h], radius=r, fill=INK)
    # line 2: shorter, remembered
    y += bar_h + gap
    rounded(d, [x0, y, x0 + content * 0.72, y + bar_h], radius=r, fill=INK)
    # line 3: hidden — only the rule is left
    y += bar_h + gap * 1.5
    rule_h = bar_h * 0.55
    rounded(d, [x0, y, x0 + content, y + rule_h], radius=rule_h / 2, fill=RULE)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name, maskable in [
        (192, "icon-192.png", False),
        (512, "icon-512.png", False),
        (512, "maskable-512.png", True),
        (180, "apple-touch-icon-180.png", False),
    ]:
        render(size, maskable).save(OUT / name)
        print(f"wrote {OUT / name}")


if __name__ == "__main__":
    main()
