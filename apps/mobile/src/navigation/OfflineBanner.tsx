/**
 * Connection strip (§M13/§M21). A thin, calm line under the header whenever the app cannot do
 * what the user expects — the app itself keeps working from local state either way.
 *
 * It reports the REALTIME link, not just the OS network flag. The confusing case was never
 * "no signal" (the phone already says that): it was full signal with a dead socket after a server
 * restart or an expired token, where the app looked perfectly online while messages quietly
 * stopped arriving. A degraded link is announced only after a grace window, so an ordinary cold
 * start does not flash a banner on a healthy launch.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { Text } from '../design-system';
import {
  useConnectivity,
  useRealtimeStore,
  connectionBanner,
  BANNER_GRACE_MS,
  type BannerKind,
} from '../core';

export function OfflineBanner(): React.JSX.Element | null {
  const t = useTheme();
  const { t: tr } = useTranslation();
  const flightMode = useConnectivity(s => s.flightMode);
  const online = useConnectivity(s => s.online);
  const realtime = useRealtimeStore(s => s.connectionState);

  // When the realtime link stopped being healthy. A timestamp rather than a timer keeps this
  // allocation-free on the state changes that happen constantly (connecting → syncing → live).
  const degradedSince = useRef<number | null>(null);
  const healthy = realtime === 'live' || realtime === 'connected';
  if (healthy) degradedSince.current = null;
  else if (degradedSince.current === null) degradedSince.current = Date.now();

  // One re-render when the grace window elapses — without it a link that goes down and STAYS
  // down would never announce itself, because nothing else would change to trigger a render.
  const [, tick] = useState(0);
  useEffect(() => {
    if (healthy || flightMode || !online) return undefined;
    const timer = setTimeout(
      () => tick(n => (n + 1) % 1_000_000),
      BANNER_GRACE_MS + 50,
    );
    return () => clearTimeout(timer);
  }, [healthy, flightMode, online, realtime]);

  const kind: BannerKind | null = connectionBanner({
    flightMode,
    online,
    realtime,
    degradedForMs:
      degradedSince.current === null ? 0 : Date.now() - degradedSince.current,
  });
  if (kind === null) return null;

  // `syncing` is progress, not a fault — it gets the brand colour rather than the warning one.
  const dot =
    kind === 'flightMode' || kind === 'syncing'
      ? t.colors.brandFrom
      : t.colors.warning;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: t.spacing.xs,
        paddingVertical: t.spacing.xs,
        paddingHorizontal: t.spacing.lg,
        backgroundColor: t.colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: t.colors.hairline,
      }}
    >
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: dot,
        }}
      />
      <Text variant="caption" color="secondary">
        {tr(`common.${kind}`)}
      </Text>
    </View>
  );
}
