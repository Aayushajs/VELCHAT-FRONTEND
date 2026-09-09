/**
 * The banner that explains why notifications are silent, and fixes it in one tap.
 *
 * This is the piece WhatsApp has, and the reason it appears to "always work": on Android a
 * correctly-configured app still receives nothing when Doze or an OEM power manager refuses to
 * start it for a data message. FCM reports the push delivered and the app never runs — no error,
 * no callback, nothing to log. Guiding the user to the switch is the only real fix, and it also
 * restores the SENDER's second tick, since a service that never starts cannot acknowledge
 * delivery.
 *
 * Deliberately quiet: one line, dismissible for a week, and it disappears by itself once the
 * setting is actually changed (the hook re-checks on every foreground).
 */
import React from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from '../../../theme';
import { Text, spacing } from '../../../design-system';
import { usePushBlocker } from '../hooks/usePushBlocker';

export function PushBlockerBanner(): React.JSX.Element | null {
  const t = useTheme();
  const { blocker, fix, dismiss } = usePushBlocker();
  if (!blocker) return null;

  const copy =
    blocker === 'battery-restricted'
      ? {
          title: 'Notifications may be delayed',
          body: 'Android can stop VelChat in the background. Tap to let it run.',
          action: 'Allow',
        }
      : {
          title: 'Notifications are off',
          body: 'You will not be told about new messages.',
          action: 'Turn on',
        };

  return (
    <View
      style={{
        marginHorizontal: spacing.md,
        marginVertical: spacing.xs,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        borderRadius: 14,
        // Informational, not alarming: this is not a failure the user caused.
        backgroundColor: t.colors.bgSubtle,
        borderWidth: 1,
        borderColor: t.colors.hairline,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <View style={{ flex: 1, paddingRight: spacing.sm }}>
        <Text
          variant="label"
          numberOfLines={1}
          style={{ fontSize: 14, color: t.colors.textPrimary }}
        >
          {copy.title}
        </Text>
        <Text
          variant="body"
          numberOfLines={2}
          style={{
            fontSize: 12,
            lineHeight: 17,
            color: t.colors.textSecondary,
          }}
        >
          {copy.body}
        </Text>
      </View>

      <Pressable
        onPress={fix}
        accessibilityRole="button"
        accessibilityLabel={copy.action}
        hitSlop={8}
        style={{
          paddingHorizontal: spacing.sm,
          paddingVertical: 6,
          borderRadius: 999,
          backgroundColor: t.colors.brandFrom,
        }}
      >
        <Text variant="body" style={{ fontSize: 12, color: t.colors.actionFg }}>
          {copy.action}
        </Text>
      </Pressable>

      <Pressable
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={12}
        style={{ paddingLeft: spacing.sm }}
      >
        <Text
          variant="body"
          style={{ fontSize: 14, color: t.colors.textTertiary }}
        >
          ✕
        </Text>
      </Pressable>
    </View>
  );
}
