/**
 * Chats list (§F2) — WhatsApp-style rows on a FlashList (recycled, 55+ FPS on the ref
 * device, §R4), reading straight from WatermelonDB via `useConversations`. Pinned float
 * to the top, then most-recent; unread count as a brand pill. Instant open (DB-backed).
 */
import React, { useCallback } from 'react';
import { View, Pressable, Image, type ViewStyle } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../../theme';
import { useTranslation } from '../../../i18n';
import {
  Text,
  UserIcon,
  ChatIcon,
  ChatPlusIcon,
  spacing,
} from '../../../design-system';
import { useTypingUser } from '../../../core';
import type { RootStackParamList } from '../../../navigation/types';
import { PushBlockerBanner } from '../../notifications';
import {
  useConversations,
  type ConversationRowVM,
} from '../hooks/useConversations';

const AVATAR = 54;

// Hoisted: an inline literal is a fresh prop identity on every render, which invalidates
// FlashList's internal memoisation of the scroll container. `spacing` is the same static
// token the theme carries, so the rendered padding is unchanged.
const LIST_CONTENT_STYLE: ViewStyle = { paddingVertical: spacing.xs };

// Cheerful, stable per-name colour so a no-photo avatar is a coloured initial (WhatsApp-style).
const AVATAR_COLORS = [
  '#7C3AED',
  '#DB2777',
  '#2563EB',
  '#059669',
  '#D97706',
  '#DC2626',
  '#0891B2',
  '#9333EA',
];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1)
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? '#7C3AED';
}

interface ConversationRowProps {
  id: string;
  name: string | undefined;
  preview: string;
  time: string;
  unreadCount: number;
  isDm: boolean;
  /** Already-resolved peer photo; absent → coloured initial. Never fetched during render. */
  peerAvatarUrl: string | undefined;
  onOpen: (id: string, name?: string) => void;
}

// Props are PRIMITIVES, not the DB row: WatermelonDB mutates its cached model in place and
// re-emits the same reference, so a memo keyed on the model would never see this row's own
// changes (unread cleared, a new preview on the chat already at the top). Memoised so a
// message arriving in ANY conversation only re-renders the rows that actually changed.
// `onOpen` is a stable handler from the parent, so prop identity holds across re-emits.
function ConversationRowBase({
  id,
  name,
  preview,
  time,
  unreadCount,
  isDm,
  peerAvatarUrl,
  onOpen,
}: ConversationRowProps): React.JSX.Element {
  const t = useTheme();
  const { t: tr } = useTranslation();
  const initial = (name ?? '?').trim().charAt(0).toUpperCase();
  const unread = unreadCount > 0;
  // Typing wins over the last-message preview for this conversation (§C4, ephemeral store).
  const typing = useTypingUser(id) !== null;
  // The photo arrives ON THE ROW, resolved once by the inbox sync. Fetching it here — a members
  // lookup, a profile, then a media URL — meant three requests per row per recycle, so scrolling a
  // long list queued hundreds of them and the photos landed late, out of order, or never.
  const dp = isDm ? peerAvatarUrl : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name ?? 'Chat'}
      onPress={() => onOpen(id, name)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingHorizontal: t.spacing.lg,
        paddingVertical: t.spacing.sm,
        backgroundColor: pressed ? t.colors.bgSubtle : 'transparent',
      })}
    >
      <View
        style={{
          width: AVATAR,
          height: AVATAR,
          borderRadius: AVATAR / 2,
          backgroundColor:
            initial && initial !== '?'
              ? avatarColor(name ?? '')
              : t.colors.bgSubtle,
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
        ) : initial && initial !== '?' ? (
          <Text variant="title" style={{ color: '#fff' }}>
            {initial}
          </Text>
        ) : (
          <UserIcon size={26} color={t.colors.textTertiary} strokeWidth={2} />
        )}
      </View>

      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text
            variant="body"
            numberOfLines={1}
            style={{ flex: 1, fontSize: 17, color: t.colors.textPrimary }}
          >
            {name ?? '—'}
          </Text>
          <Text
            variant="caption"
            style={{
              color: unread ? t.colors.brandFrom : t.colors.textTertiary,
            }}
          >
            {time}
          </Text>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.spacing.xs,
          }}
        >
          {typing ? (
            <Text
              variant="caption"
              numberOfLines={1}
              style={{ flex: 1, fontSize: 14, color: t.colors.brandFrom }}
            >
              {tr('chat.typing')}
            </Text>
          ) : (
            <Text
              variant="caption"
              color="secondary"
              numberOfLines={1}
              style={{ flex: 1, fontSize: 14 }}
            >
              {preview}
            </Text>
          )}
          {unread ? (
            <View
              style={{
                minWidth: 20,
                height: 20,
                paddingHorizontal: 6,
                borderRadius: 10,
                backgroundColor: t.colors.brandFrom,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                variant="caption"
                style={{ color: t.colors.actionFg, fontSize: 12 }}
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export const ConversationRow = React.memo(ConversationRowBase);

export function ChatsList(): React.JSX.Element {
  const t = useTheme();
  const { t: tr } = useTranslation();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { rows, loaded } = useConversations();
  const onOpen = useCallback(
    (id: string, name?: string) => {
      navigation.navigate('Chat', { conversationId: id, name });
    },
    [navigation],
  );
  const openNewChat = useCallback(() => {
    navigation.navigate('NewChat');
  }, [navigation]);
  const renderItem = useCallback(
    ({ item }: { item: ConversationRowVM }) => (
      <ConversationRow
        id={item.id}
        name={item.name}
        preview={item.preview}
        time={item.time}
        unreadCount={item.unread}
        isDm={item.type === 'dm'}
        peerAvatarUrl={item.peerAvatarUrl}
        onOpen={onOpen}
      />
    ),
    [onOpen],
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bgBase }}>
      {/* Above the list, and above the empty state too: a user with no chats yet is exactly the
          one who needs to be told notifications will not reach them. Renders nothing when there
          is nothing wrong. */}
      <PushBlockerBanner />
      {/* Nothing until the first DB emission — an ungated empty state flashes "no chats
          yet" on every cold start / tab mount before the rows land. */}
      {rows.length > 0 ? (
        <FlashList
          data={rows}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={LIST_CONTENT_STYLE}
          showsVerticalScrollIndicator={false}
        />
      ) : loaded ? (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: t.spacing.xl,
            gap: t.spacing.xs,
          }}
        >
          <ChatIcon size={44} color={t.colors.textTertiary} strokeWidth={1.6} />
          <Text
            variant="title"
            align="center"
            style={{ marginTop: t.spacing.sm, fontSize: 19 }}
          >
            {tr('chat.emptyTitle')}
          </Text>
          <Text variant="body" color="tertiary" align="center">
            {tr('chat.emptySub')}
          </Text>
        </View>
      ) : null}

      {/* Compose FAB — the entry point to start a new chat (§F2). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('chat.newChat')}
        onPress={openNewChat}
        style={({ pressed }) => ({
          position: 'absolute',
          right: t.spacing.lg,
          bottom: t.spacing.xl,
          width: 58,
          height: 58,
          borderRadius: 29,
          backgroundColor: t.colors.brandFrom,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.85 : 1,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
          elevation: 5,
        })}
      >
        <ChatPlusIcon size={24} color={t.colors.actionFg} strokeWidth={2.2} />
      </Pressable>
    </View>
  );
}
