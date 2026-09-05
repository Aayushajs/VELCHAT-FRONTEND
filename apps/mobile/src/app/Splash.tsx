/**
 * Boot splash (§L2) — shown while the launch bootstrap decides the auth state
 * (stored session vs. silent device-key re-login vs. onboarding). Prevents an
 * onboarding→home flicker. Themed (light/dark).
 */
import React from 'react';
import { View, Image } from 'react-native';
import VELCHAT_MARK from './assets/velchat-mark.png';

export function Splash(): React.JSX.Element {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#000000',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Image
        source={VELCHAT_MARK}
        accessibilityLabel="VelChat"
        style={{ width: 132, height: 132 }}
        resizeMode="contain"
      />
    </View>
  );
}
