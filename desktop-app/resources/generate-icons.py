#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).parent
SIZE = 1024

def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

# App icon: the Image2 CodeLight lamp with physical Codex/Claude badges.
source = Image.open(ROOT / 'codelight-logo-source.png').convert('RGBA')
canvas = ImageOps.fit(source, (SIZE, SIZE), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
canvas.save(ROOT / 'icon.png')
canvas.save(ROOT / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])

# Monochrome macOS menu-bar template. Keep the logical image at 18 pt;
# Electron otherwise treats a large source bitmap as an oversized status item.
tray_scale = 4
tray_source = Image.new('RGBA', (18 * tray_scale, 18 * tray_scale), (0, 0, 0, 0))
td = ImageDraw.Draw(tray_source)
for x, y, width, height in ((2, 10, 3.5, 7), (7, 6, 3.5, 11), (12, 2, 3.5, 15)):
    td.rounded_rectangle(
        (x * tray_scale, y * tray_scale, (x + width) * tray_scale, (y + height) * tray_scale),
        radius=1.75 * tray_scale,
        fill=(255,255,255,255),
    )
tray = tray_source.resize((18, 18), Image.Resampling.LANCZOS)
tray.save(ROOT / 'trayTemplate.png')
tray_source.resize((36,36), Image.Resampling.LANCZOS).save(ROOT / 'trayTemplate@2x.png')

iconset = ROOT / 'icon.iconset'
iconset.mkdir(exist_ok=True)
for logical in [16,32,128,256,512]:
    canvas.resize((logical, logical), Image.Resampling.LANCZOS).save(iconset / f'icon_{logical}x{logical}.png')
    canvas.resize((logical*2, logical*2), Image.Resampling.LANCZOS).save(iconset / f'icon_{logical}x{logical}@2x.png')
print(ROOT)
