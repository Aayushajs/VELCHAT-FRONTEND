// Generates Android and iOS icon families from the single VelChat brand mark.
// The app tile is always pure black like the approved mark. Android gets a
// correctly padded adaptive foreground; iOS gets opaque square source files.
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
const SRC = path.join(repoRoot, 'brand', 'velchat-mark.svg');
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
const JS_APP_TILE = path.join(
  appRoot,
  'src',
  'design-system',
  'assets',
  'velchat-icon.png',
);
const IOS_SPLASH = path.join(
  appRoot,
  'ios',
  'VelChat',
  'Images.xcassets',
  'SplashLogo.imageset',
);
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };
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

async function trimmedLogo() {
  // Trim the transparent border to a tight logo, keep alpha.
  return sharp(SRC).ensureAlpha().trim({ threshold: 10 }).toBuffer();
}

async function onField(logo, size, coverage, background) {
  const inner = Math.round(size * coverage);
  const resized = await sharp(logo)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([{ input: resized, top: pad, left: pad }])
    .png()
    .toBuffer();
}

async function circleMask(square, size) {
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  return sharp(square)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function main() {
  const logo = await trimmedLogo();
  for (const [density, px] of Object.entries(LEGACY)) {
    const dir = path.join(RES, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    // 64% gives the mark enough presence without Android's launcher masks
    // crowding the rounded ends. It remains inside the 66dp adaptive safe area.
    const square = await onField(logo, px, 0.64, BLACK);
    writeFileSync(path.join(dir, 'ic_launcher.png'), square);
    writeFileSync(
      path.join(dir, 'ic_launcher_round.png'),
      await circleMask(square, px),
    );
    // Adaptive/splash foreground: logo on transparent (system draws the bg + mask).
    const fg = await onField(logo, ADAPTIVE[density], 0.6, TRANSPARENT);
    writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), fg);
  }

  // Adaptive icon (API 26+): black background + transparent white mark.
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
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#000000</color>\n</resources>\n`,
  );

  // iOS requires opaque, square PNGs; iOS applies its own rounded-corner mask.
  mkdirSync(IOS_APP_ICON, { recursive: true });
  for (const [filename, px] of IOS_ICONS) {
    writeFileSync(
      path.join(IOS_APP_ICON, filename),
      await onField(logo, px, 0.64, BLACK),
    );
  }

  // Transparent mark over the native/React black launch fields.
  const splashLogo = await onField(logo, 512, 0.68, TRANSPARENT);
  mkdirSync(path.dirname(JS_SPLASH), { recursive: true });
  writeFileSync(JS_SPLASH, splashLogo);
  // Header usage needs the exact black tile rather than a white mark over an
  // arbitrary screen color, so it cannot disappear in either app theme.
  mkdirSync(path.dirname(JS_APP_TILE), { recursive: true });
  writeFileSync(JS_APP_TILE, await onField(logo, 512, 0.64, BLACK));
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
    'OK  Android and iOS launcher icons, native splash art, and in-app brand assets generated from brand/velchat-mark.svg (rebuild to see them).',
  );
}

main().catch(e => {
  console.error('FAIL icon generation:', e.message);
  process.exit(1);
});
