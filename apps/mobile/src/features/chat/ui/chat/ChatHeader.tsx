/**
 * Chat header (§F2) — back chevron · circular peer avatar (initial letter for now) · name
 * with a reserved presence line (real presence is a follow-up; the row height stays stable)
 * · video-call, voice-call and overflow buttons. Surface background, hairline underline; the
 * top safe-area inset is owned by the parent Screen. Call/overflow are no-op stubs for now.
 */
import React from 'react';
import { View, Pressable, Image } from 'react-native';
import { useTheme } from '../../../../theme';
import { useTranslation } from '../../../../i18n';
import {
  Text,
  ChevronRightIcon,
  VideoIcon,
  CallIcon,
  MoreIcon,
  UserIcon,
  type IconProps,
} from '../../../../design-system';
import { useConversationIdentity } from '../../hooks/useConversationIdentity';
import {
  useChatHeaderPresence,
  type PresenceEntry,
} from '../../hooks/useChatHeaderPresence';
import { presenceTimeLabel } from './chatModel';

const AVATAR = 40;

/**
 * Resolve the reserved presence-line text + colour: typing WINS (brand), else online / last-seen
 * from presence, else `null` (a blank spacer keeps the header height stable). Pure.
 */
function derivePresenceLine(
  typing: boolean,
  presence: PresenceEntry | undefined,
  tr: ReturnType<typeof useTranslation>['t'],
): { text: string | null; brand: boolean } {
  if (typing) return { text: tr('chat.typing'), brand: true };
  if (presence) {
    if (presence.status !== 'offline')
      return { text: tr('chat.online'), brand: false };
    if (presence.lastSeen !== null) {
      const time = presenceTimeLabel(
        presence.lastSeen,
        Date.now(),
        tr('chat.yesterday'),
      );
      return { text: tr('chat.lastSeen', { time }), brand: false };
    }
  }
  return { text: null, brand: false };
}

const noop = (): void => undefined;

function HeaderIconButton({
  label,
  onPress,
  icon: Icon,
}: {
  label: string;
  onPress: () => void;
  icon: (props: IconProps) => React.JSX.Element;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon size={23} color={t.colors.textPrimary} strokeWidth={2} />
    </Pressable>
  );
}

export function ChatHeader({
  conversationId,
  name,
  onBack,
}: {
  conversationId: string;
  name: string | undefined;
  onBack: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const { t: tr } = useTranslation();
  const title = name ?? tr('tabs.chats');
  const initial = (name ?? '').trim().charAt(0).toUpperCase();
  const { typing, presence } = useChatHeaderPresence(conversationId);
  // The photo comes from the conversation row the inbox sync already resolved, so the header is
  // complete on the first frame instead of three round-trips after the tap. Stale entries are
  // revalidated in the background by the hook, and the row is observed, so a changed picture
  // appears without the user doing anything.
  const { peerAvatarUrl } = useConversationIdentity(conversationId);
  const dp = peerAvatarUrl;
  const presenceLine = derivePresenceLine(typing, presence, tr);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 60,
        paddingLeft: t.spacing.xs,
        paddingRight: t.spacing.xs,
        backgroundColor: t.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: t.colors.hairline,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('profile.back')}
        onPress={onBack}
        hitSlop={10}
        style={({ pressed }) => ({
          width: 36,
          height: 40,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View style={{ transform: [{ rotate: '180deg' }] }}>
          <ChevronRightIcon
            size={26}
            color={t.colors.textPrimary}
            strokeWidth={2.2}
          />
        </View>
      </Pressable>

      <View
        style={{
          width: AVATAR,
          height: AVATAR,
          borderRadius: AVATAR / 2,
          marginRight: t.spacing.sm,
          backgroundColor: t.colors.bgSubtle,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {dp ? (
          <Image
            source={{ uri: dp }}
            style={{ width: AVATAR, height: AVATAR }}
            resizeMode="cover"
          />
        ) : initial ? (
          <Text variant="label" style={{ color: t.colors.textSecondary }}>
            {initial}
          </Text>
        ) : (
          <UserIcon size={22} color={t.colors.textTertiary} strokeWidth={2} />
        )}
      </View>

      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text
          variant="label"
          numberOfLines={1}
          style={{ fontSize: 17, color: t.colors.textPrimary }}
        >
          {title}
        </Text>
        {/* Reserved presence line (§A15/§C4): typing wins (brand), else online / last-seen, else a
            blank spacer so the header height never jumps. */}
        <Text
          variant="caption"
          numberOfLines={1}
          style={{
            fontSize: 12,
            lineHeight: 15,
            color: presenceLine.brand
              ? t.colors.brandFrom
              : t.colors.textTertiary,
          }}
        >
          {presenceLine.text ?? ' '}
        </Text>
      </View>

      <HeaderIconButton
        label={tr('chat.videoCall')}
        onPress={noop}
        icon={VideoIcon}
      />
      <HeaderIconButton
        label={tr('chat.call')}
        onPress={noop}
        icon={CallIcon}
      />
      <HeaderIconButton
        label={tr('chat.more')}
        onPress={noop}
        icon={MoreIcon}
      />
    </View>
  );
}
