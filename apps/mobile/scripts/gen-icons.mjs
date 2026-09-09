// Generates Android and iOS icon families from the single VelChat brand mark.
// The app tile is always the mark's own near-black field; Android gets a
// correctly padded adaptive foreground, iOS gets opaque square source files.
//
// The source mark is authored as an opaque near-black field with the glyph on
// top, so it is alpha-keyed against that field first: alpha carries the glyph
// coverage and the colour is un-multiplied, which reproduces the source pixel
// for pixel once it is composited back over the same black. Nothing is ever
// cropped or re-drawn - the glyph is only scaled and centred.
//
// Usage: pnpm --filter @velchat/mobile icons
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(appRoot, '..', '..');
const SRC = path.join(repoRoot, 'brand', 'velchat-mark1.svg');
const RES = path.join(appRoot, 'android', 'app', 'src', 'main', 'res');
const IOS_APP_ICON = path.join(
  appRoot,
  'ios',
  'VelChat',
  'Images.xcassets',
  'AppIcon.appiconset',
);
const JS_SPLASH = path.join(
  appRoot,
  'src',
  'app',
  'assets',
  'velchat-mark.png',
);
const IOS_SPLASH = path.join(
  appRoot,
  'ios',
  'VelChat',
  'Images.xcassets',
  'SplashLogo.imageset',
);

// The mark's own field colour, read back off the source at generation time so
// the adaptive background is declared as the exact same black.
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// Legacy launcher px per density; adaptive foreground is 108dp (2.25x the legacy 48).
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const ADAPTIVE = {
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};

// Largest scale at which every glyph pixel still sits inside Android's 66dp
// safe circle of the 108dp adaptive canvas, measured from the mark itself (its
// furthest pixel is 0.6044x its own height from the bbox centre):
// (33/108) / 0.6044 = 0.5055. Any launcher mask - circle, squircle, teardrop -
// leaves the glyph untouched and only ever trims the black field.
const ADAPTIVE_COVERAGE = 0.5055;
// An adaptive icon shows 72 of its 108dp, so 1.5x reproduces the same apparent
// size on the unmasked legacy, iOS and splash tiles.
const TILE_COVERAGE = ADAPTIVE_COVERAGE * 1.5;

const IOS_ICONS = [
  ['Icon-20@2x.png', 40],
  ['Icon-20@3x.png', 60],
  ['Icon-29@2x.png', 58],
  ['Icon-29@3x.png', 87],
  ['Icon-40@2x.png', 80],
  ['Icon-40@3x.png', 120],
  ['Icon-60@2x.png', 120],
  ['Icon-60@3x.png', 180],
  ['Icon-1024.png', 1024],
];

// Anything this far above the field counts as glyph, so the tight crop keeps
// the rasteriser's anti-aliased rim instead of shaving it off.
const GLYPH_FLOOR = 2;

// Renders the source far above every output size (so each icon is a downscale,
// never an upscale), keys the field out, and crops tight to the glyph.
async function keyedLogo() {
  const { data, info } = await sharp(SRC, { density: 600 })
    .resize({ width: 2160, height: 3840, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const field = Math.max(data[0], data[1], data[2]); // the mark's own black
  const span = 255 - field;

  const rgba = Buffer.alloc(width * height * 4);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = (y * width + x) * 4;
      const lum = Math.max(data[s], data[s + 1], data[s + 2]);
      if (lum - field < GLYPH_FLOOR) continue; // field stays fully transparent
      const alpha = Math.min(1, (lum - field) / span);
      for (let c = 0; c < 3; c++) {
        // Un-multiply so compositing over the field restores the source pixel.
        const v = field + (data[s + c] - field) / alpha;
        rgba[d + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      rgba[d + 3] = Math.round(alpha * 255);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error(`no glyph found in ${SRC}`);

  const logo = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    })
    .png()
    .toBuffer();
  return { logo, field };
}

// Centres the whole glyph inside a square of `size`, scaled to `coverage` of
// it. `fit: 'contain'` scales by the longer edge, so the glyph keeps its exact
// aspect ratio and never loses a pixel.
async function onField(logo, size, coverage, background) {
  const inner = Math.round(size * coverage);
  const resized = await sharp(logo)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .toBuffer();
  const { width, height } = await sharp(resized).metadata();
  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([
      {
        input: resized,
        top: Math.round((size - height) / 2),
        left: Math.round((size - width) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function circleMask(square, size) {
  const r = size / 2;
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`,
  );
  return sharp(square)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function main() {
  const { logo, field } = await keyedLogo();
  const opaque = { r: field, g: field, b: field, alpha: 1 };
  const fieldHex = `#${field.toString(16).padStart(2, '0').repeat(3)}`;

  for (const [density, px] of Object.entries(LEGACY)) {
    const dir = path.join(RES, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    const square = await onField(logo, px, TILE_COVERAGE, opaque);
    writeFileSync(path.join(dir, 'ic_launcher.png'), square);
    writeFileSync(
      path.join(dir, 'ic_launcher_round.png'),
      await circleMask(square, px),
    );
    // Adaptive + Android 12 splash foreground: glyph on transparent, because
    // the system draws the background layer and then applies its own mask.
    writeFileSync(
      path.join(dir, 'ic_launcher_foreground.png'),
      await onField(logo, ADAPTIVE[density], ADAPTIVE_COVERAGE, TRANSPARENT),
    );
  }

  // Adaptive icon (API 26+): the mark's black field + the keyed glyph. The same
  // foreground doubles as the monochrome layer, so a themed launcher tints the
  // glyph's silhouette rather than a solid tile.
  const v26 = path.join(RES, 'mipmap-anydpi-v26');
  mkdirSync(v26, { recursive: true });
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  writeFileSync(path.join(v26, 'ic_launcher.xml'), adaptiveXml);
  writeFileSync(path.join(v26, 'ic_launcher_round.xml'), adaptiveXml);

  const valuesDir = path.join(RES, 'values');
  mkdirSync(valuesDir, { recursive: true });
  writeFileSync(
    path.join(valuesDir, 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${fieldHex}</color>\n</resources>\n`,
  );

  // iOS requires opaque, square PNGs; iOS applies its own rounded-corner mask.
  mkdirSync(IOS_APP_ICON, { recursive: true });
  for (const [filename, px] of IOS_ICONS) {
    writeFileSync(
      path.join(IOS_APP_ICON, filename),
      await sharp(await onField(logo, px, TILE_COVERAGE, opaque))
        .flatten({ background: opaque }) // the App Store rejects an alpha channel
        .png()
        .toBuffer(),
    );
  }

  // Transparent glyph over the native/React black launch fields.
  const splashLogo = await onField(logo, 512, TILE_COVERAGE, TRANSPARENT);
  mkdirSync(path.dirname(JS_SPLASH), { recursive: true });
  writeFileSync(JS_SPLASH, splashLogo);
  mkdirSync(IOS_SPLASH, { recursive: true });
  writeFileSync(path.join(IOS_SPLASH, 'SplashLogo.png'), splashLogo);
  writeFileSync(
    path.join(IOS_SPLASH, 'Contents.json'),
    `${JSON.stringify(
      {
        images: [
          { filename: 'SplashLogo.png', idiom: 'universal', scale: '1x' },
        ],
        info: { author: 'xcode', version: 1 },
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `OK  Android + iOS launcher icons and splash art generated from brand/velchat-mark1.svg on field ${fieldHex} (rebuild to see them).`,
  );
}

main().catch(e => {
  console.error('FAIL icon generation:', e.message);
  process.exit(1);
});
