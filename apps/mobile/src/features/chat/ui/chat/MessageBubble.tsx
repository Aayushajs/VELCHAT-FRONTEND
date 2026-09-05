/**
 * A single message row (§F2/§L6): an optional date separator, then the bubble — mine on the
 * right (brand fill / inverse text), theirs on the left (subtle fill / primary text). Same-
 * sender runs are grouped tight; only the FIRST (top) bubble of a run carries the corner
 * tail. Mine keep the per-state send indicator (clock / ✓ / ✓✓ / read / failed+retry).
 *
 * Props are PRIMITIVES, not the DB row: WatermelonDB mutates its cached model in place, so a
 * memoised row keyed on the object reference would never see sending→sent→read. Passing the
 * mutable fields (state, contentPlain, time) as primitives makes the memo correct. The `time`
 * label arrives already formatted — ICU formatting is done once per emission by the screen,
 * never per row per render (§R4).
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { useTheme } from '../../../../theme';
import { useTranslation } from '../../../../i18n';
import { Text, ClockIcon } from '../../../../design-system';
import { DateChip } from './DateChip';

const BUBBLE_MAX_WIDTH = '80%';
const TAIL_RADIUS = 4;
const GAP_WITHIN_RUN = 2;
const GAP_BETWEEN_RUNS = 10;

/**
 * Per-state send indicator for MY messages: a clock while sending, one check when sent,
 * double checks when delivered, blue double checks when read, and a tappable failed marker —
 * so a failed send never masquerades as delivered (the WhatsApp contract).
 */
function SendStatus({
  state,
  onRetry,
}: {
  state: string;
  onRetry: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const { t: tr } = useTranslation();
  if (state === 'sending') {
    return <ClockIcon size={13} color={t.colors.actionFg} strokeWidth={2} />;
  }
  if (state === 'failed') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('newChat.retry')}
        onPress={onRetry}
        hitSlop={8}
        style={({ pressed }) => ({
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: t.colors.danger,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text
          variant="caption"
          style={{ fontSize: 11, lineHeight: 13, color: t.colors.actionFg }}
        >
          !
        </Text>
      </Pressable>
    );
  }
  const read = state === 'read';
  return (
    <Text
      variant="caption"
      style={{
        fontSize: 12,
        color: read ? t.colors.info : t.colors.actionFg,
        opacity: read ? 1 : 0.75,
      }}
    >
      {state === 'sent' ? '✓' : '✓✓'}
    </Text>
  );
}

interface MessageBubbleProps {
  contentPlain: string;
  mine: boolean;
  state: string;
  /** Pre-formatted time-of-day (see `compactTime`) — not a timestamp. */
  time: string;
  clientMsgId: string;
  firstOfRun: boolean;
  dateLabel: string | null;
  onRetry: (clientMsgId: string) => void;
}

function MessageBubbleBase({
  contentPlain,
  mine,
  state,
  time,
  clientMsgId,
  firstOfRun,
  dateLabel,
  onRetry,
}: MessageBubbleProps): React.JSX.Element {
  const t = useTheme();
  const R = t.radius.lg;
  const topGap = dateLabel ? 0 : firstOfRun ? GAP_BETWEEN_RUNS : GAP_WITHIN_RUN;
  return (
    <View>
      {dateLabel ? <DateChip label={dateLabel} /> : null}
      <View
        style={{
          paddingHorizontal: t.spacing.md,
          paddingTop: topGap,
          alignItems: mine ? 'flex-end' : 'flex-start',
        }}
      >
        <View
          style={{
            maxWidth: BUBBLE_MAX_WIDTH,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: R,
            borderTopRightRadius: mine && firstOfRun ? TAIL_RADIUS : R,
            borderTopLeftRadius: !mine && firstOfRun ? TAIL_RADIUS : R,
            backgroundColor: mine ? t.colors.brandFrom : t.colors.bgSubtle,
          }}
        >
          <Text
            variant="body"
            style={{
              fontSize: 15,
              lineHeight: 20,
              color: mine ? t.colors.actionFg : t.colors.textPrimary,
            }}
          >
            {contentPlain}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              alignSelf: 'flex-end',
              marginTop: 2,
            }}
          >
            <Text
              variant="caption"
              style={{
                fontSize: 11,
                color: mine ? t.colors.actionFg : t.colors.textTertiary,
                opacity: mine ? 0.75 : 1,
              }}
            >
              {time}
            </Text>
            {mine ? (
              <SendStatus state={state} onRetry={() => onRetry(clientMsgId)} />
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

export const MessageBubble = React.memo(MessageBubbleBase);
