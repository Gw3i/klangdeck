"""Generate Klangdeck's original app icon; Pillow is only needed to regenerate it."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

root = Path(__file__).resolve().parent.parent
assets = root / 'assets'
iconset = root / '.packaging' / 'Klangdeck.iconset'
assets.mkdir(exist_ok=True)
iconset.mkdir(parents=True, exist_ok=True)
image = Image.new('RGBA', (1024, 1024))
shadow = Image.new('RGBA', image.size)
ImageDraw.Draw(shadow).rounded_rectangle((74, 97, 950, 970), 205, fill=(24, 35, 49, 70))
image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(20)))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((74, 62, 950, 933), 195, fill='#bdc7cf')
draw.rounded_rectangle((74, 42, 950, 908), 195, fill='#eaf0f3')
draw.rounded_rectangle((105, 73, 919, 875), 165, fill='#d7e0e6', outline='#f8fcff', width=7)
colors = ['#c2d8ee', '#eaf2f8', '#adcce9', '#eff5f9', '#bfd8ef', '#edf4fa', '#b7d2eb', '#e8f1f8', '#c7deef']
for index, color in enumerate(colors):
    x, y = 154 + (index % 3) * 246, 145 + (index // 3) * 235
    draw.rounded_rectangle((x, y + 13, x + 222, y + 216), 46, fill='#8f9eac')
    draw.rounded_rectangle((x, y, x + 222, y + 192), 46, fill=color, outline='#f6fbff', width=5)
    draw.rounded_rectangle((x + 20, y + 17, x + 202, y + 168), 42, fill=color)
    draw.ellipse((x + 98, y + 81, x + 124, y + 107), fill='#617c96')
image.save(assets / 'icon.png')
for size in (16, 32, 128, 256, 512):
    image.resize((size, size), Image.Resampling.LANCZOS).save(iconset / f'icon_{size}x{size}.png')
    image.resize((size * 2, size * 2), Image.Resampling.LANCZOS).save(iconset / f'icon_{size}x{size}@2x.png')
image.save(assets / 'icon.icns', format='ICNS')
