/**
 * Launch surface (§L2) — the contract that kills the cold-start flash.
 *
 * Three independent things paint the screen before the home screen appears:
 *   1. the API 31+ system splash    (windowSplashScreenBackground + AnimatedIcon)
 *   2. the activity window          (android:windowBackground, and on API 24-30
 *                                    this is the FIRST thing shown)
 *   3. the JS <Splash /> component  (rendered until useAuthBootstrap resolves)
 *
 * If any of them disagrees on the field colour or the mark, a cold start shows a
 * flash. `android:windowBackground` was previously left undeclared, so it fell
 * through to AppCompat's default — #FAFAFA in day mode, #303030 at night —
 * producing a near-white frame between the black system splash and the black JS
 * splash. These tests pin all three to one field and one mark.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react-native';
import { Splash, BRAND_FIELD, SPLASH_MARK_BOX, SPLASH_ICON_FRAME } from '../Splash';

const RES = path.resolve(__dirname, '../../../android/app/src/main/res');
const read = (rel: string): string =>
  readFileSync(path.join(RES, rel), 'utf8');

// Every theme variant that can be the resolved AppTheme on a supported device:
// values/ = API 24-30 day, values-night/ = night, values-v31/ = API 31+ day.
const THEMES = [
  'values/styles.xml',
  'values-night/styles.xml',
  'values-v31/styles.xml',
];

test('the JS brand field is the same black the launcher icon is generated on', () => {
  const declared = /<color name="ic_launcher_background">([^<]+)</.exec(
    read('values/ic_launcher_background.xml'),
  );
  expect(declared).not.toBeNull();
  expect(declared?.[1]?.toLowerCase()).toBe(BRAND_FIELD.toLowerCase());
});

test.each(THEMES)(
  '%s declares windowBackground as the splash drawable, so no AppCompat default shows through',
  file => {
    const xml = read(file);
    expect(xml).toMatch(
      /<item name="android:windowBackground">@drawable\/splash_screen<\/item>/,
    );
  },
);

test('the splash drawable paints the brand field and centres the same mark the system splash uses', () => {
  const xml = read('drawable/splash_screen.xml');
  expect(xml).toContain('@color/ic_launcher_background');
  expect(xml).toContain('@mipmap/ic_launcher_foreground');
  // Centred at the documented system-splash icon frame, so the mark does not
  // move or resize when the system splash hands over to the window.
  expect(xml).toContain('android:gravity="center"');
  expect(xml).toContain(`android:width="${SPLASH_ICON_FRAME}dp"`);
  expect(xml).toContain(`android:height="${SPLASH_ICON_FRAME}dp"`);
});

test('the system splash field is the shared colour resource, not a hex that can drift', () => {
  for (const file of THEMES) {
    const xml = read(file);
    const declared = /<item name="android:windowSplashScreenBackground">([^<]+)</.exec(
      xml,
    );
    // Only API 31+ variants carry the attribute at all; where present it must
    // be the shared resource.
    if (declared) {
      expect(declared[1]).toBe('@color/ic_launcher_background');
    }
  }
});

test('Splash paints the brand field, not a theme colour', () => {
  render(<Splash />);
  expect(screen.getByTestId('splash-field')).toHaveStyle({
    backgroundColor: BRAND_FIELD,
  });
});

test('Splash renders the mark at the size that matches the system splash icon', () => {
  render(<Splash />);
  expect(screen.getByLabelText('VelChat')).toHaveStyle({
    width: SPLASH_MARK_BOX,
    height: SPLASH_MARK_BOX,
  });
});
