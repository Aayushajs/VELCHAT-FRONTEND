/**
 * Boot splash (§L2) — shown while the launch bootstrap decides the auth state
 * (stored session vs. silent device-key re-login vs. onboarding). Prevents an
 * onboarding→home flicker.
 *
 * Deliberately NOT themed: it is the third and last owner of the pre-home
 * surface, after the API 31+ system splash and the activity's window
 * background (`@drawable/splash_screen`). All three paint the same field and
 * the same mark at the same size, so a cold start reads as one continuous
 * brand screen and the only transition the user sees is into the app itself.
 * Painting a theme colour here would put a light frame between two black ones.
 */
import React from 'react';
import { View, Image } from 'react-native';
import VELCHAT_MARK from './assets/velchat-mark.png';

/**
 * The supplied mark's own field colour. Shared with `@color/ic_launcher_background`,
 * which is generated from the mark itself — `launchSurface.test.tsx` fails if the
 * two ever drift apart.
 */
export const BRAND_FIELD = '#010101';

/**
 * The frame the platform renders a splash icon into when the icon has no icon
 * background (Android's documented 288dp; content lives inside the inner 192dp).
 */
export const SPLASH_ICON_FRAME = 288;

/**
 * The box that lands this asset's mark at the same height as the system splash's.
 *
 * The generated assets differ on purpose: the adaptive foreground holds the mark
 * at coverage C of its 108dp canvas, while this one holds it at 1.5×C, because an
 * adaptive icon only ever shows 72 of those 108dp. The system splash scales the
 * foreground to SPLASH_ICON_FRAME, putting the mark at C × 288 — so this asset
 * needs a two-thirds-size box to put its mark at exactly the same height, and the
 * mark neither jumps nor resizes on handover.
 */
export const SPLASH_MARK_BOX = (SPLASH_ICON_FRAME * 2) / 3;

export function Splash(): React.JSX.Element {
  return (
    <View
      testID="splash-field"
      style={{
        flex: 1,
        backgroundColor: BRAND_FIELD,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Image
        source={VELCHAT_MARK}
        accessibilityLabel="VelChat"
        style={{ width: SPLASH_MARK_BOX, height: SPLASH_MARK_BOX }}
        resizeMode="contain"
      />
    </View>
  );
}
