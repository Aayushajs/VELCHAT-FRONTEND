/**
 * Chat screen (§F2) — a WhatsApp-style conversation: a header with the peer, a reversed
 * FlashList of grouped message bubbles read straight from the local DB, a jump-to-latest FAB,
 * and a composer that sends OPTIMISTICALLY (writes the DB → the bubble appears instantly; the
 * MP2 outbox transmits + reconciles later). Themed with the monochrome tokens, keyboard-aware.
 * Opened from a Chats-list row.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Keyboard,
  Platform,
  type EmitterSubscription,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type ViewStyle,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../../theme';
import { useTranslation } from '../../../i18n';
import { Screen, spacing } from '../../../design-system';
import type { RootStackParamList } from '../../../navigation/types';
import {
  useMessages,
  useSendMessage,
  useRetrySend,
} from '../hooks/useMessages';
import { useTyping } from '../hooks/useTyping';
import { ChatHeader } from './chat/ChatHeader';
import { Composer } from './chat/Composer';
import { JumpToLatest } from './chat/JumpToLatest';
import { MessageBubble } from './chat/MessageBubble';
import {
  compactTime,
  dayCategory,
  startsNewDay,
  startsNewRun,
} from './chat/chatModel';

/** Show the FAB once scrolled this far from the newest message (inverted list: y≈0 = bottom). */
const JUMP_THRESHOLD = 120;

// Hoisted: an inline literal is a fresh prop identity on every render. Same value as before
// (`spacing` is the static token the theme carries), so the rendered padding is unchanged.
const LIST_CONTENT_STYLE: ViewStyle = { paddingVertical: spacing.xs };

/**
 * A message as the list renders it: grouping decisions and ICU labels resolved ONCE per DB
 * emission, not per row per render. Doing it inline made `renderItem` depend on `messages`,
 * so every emission handed every mounted cell a new callback identity (full re-render of the
 * visible window) and re-ran `startsNewRun`/`startsNewDay` — up to 4 `Date` allocations per
 * row, every time (§R4).
 */
interface MessageRow {
  readonly id: string;
  readonly clientMsgId: string;
  readonly contentPlain: string;
  readonly mine: boolean;
  readonly state: string;
  readonly time: string;
  readonly firstOfRun: boolean;
  readonly dateLabel: string | null;
}

/** Mine/theirs bubbles are structurally different — they must not share a recycle pool. */
function messageItemType(item: MessageRow): string {
  return item.mine ? 'mine' : 'theirs';
}

export function ChatScreen(): React.JSX.Element {
  const t = useTheme();
  const { t: tr } = useTranslation();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'Chat'>>();
  const { conversationId, name } = route.params;
  const { messages, meId, loadOlder } = useMessages(conversationId);
  const send = useSendMessage(conversationId);
  const retry = useRetrySend();
  const { notifyTyping, stopTyping } = useTyping(conversationId);
  const [text, setText] = useState('');

  // Feed each keystroke to the throttled typing signal (§C4) alongside the local text state.
  const onChangeText = useCallback(
    (v: string) => {
      setText(v);
      notifyTyping(v);
    },
    [notifyTyping],
  );

  // Stable "now" for date-separator classification — it must not shift each render (that
  // would rebuild every chip label) and needn't track the midnight rollover mid-session.
  const now = useMemo(() => Date.now(), []);

  const listRef = useRef<FlashListRef<MessageRow>>(null);
  const showJumpRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = e.nativeEvent.contentOffset.y > JUMP_THRESHOLD;
    if (next !== showJumpRef.current) {
      showJumpRef.current = next;
      setShowJump(next);
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const onBack = useCallback(() => navigation.goBack(), [navigation]);

  // Keep the composer above the keyboard. KeyboardAvoidingView is unreliable under RN 0.86's
  // Android edge-to-edge (the input hid behind the keyboard); the app's proven pattern is a
  // manual keyboard-height listener (see BottomSheet) — lift the pane by the keyboard height.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const show: EmitterSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      e => setKbHeight(e.endCoordinates?.height ?? 0),
    );
    const hide: EmitterSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKbHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const onSend = useCallback(() => {
    if (!text.trim()) return;
    send(text);
    setText('');
    stopTyping();
  }, [text, send, stopTyping]);

  const dateLabelFor = useCallback(
    (ts: number): string => {
      const cat = dayCategory(ts, now);
      if (cat === 'today') return tr('chat.today');
      if (cat === 'yesterday') return tr('chat.yesterday');
      return new Date(ts).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      });
    },
    [now, tr],
  );

  // One grouping pass per emission (the window is bounded — `observeMessages` takes 50).
  const rows = useMemo<MessageRow[]>(
    () =>
      messages.map((m, i) => ({
        id: m.id,
        clientMsgId: m.clientMsgId,
        contentPlain: m.contentPlain ?? '',
        mine: m.senderId === meId,
        state: m.state,
        time: compactTime(m.createdAt),
        firstOfRun: startsNewRun(messages, i),
        dateLabel: startsNewDay(messages, i) ? dateLabelFor(m.createdAt) : null,
      })),
    [messages, meId, dateLabelFor],
  );

  // Depends only on stable references, so a new emission no longer re-renders every cell.
  const renderItem = useCallback(
    ({ item }: { item: MessageRow }) => (
      <MessageBubble
        contentPlain={item.contentPlain}
        mine={item.mine}
        state={item.state}
        time={item.time}
        clientMsgId={item.clientMsgId}
        firstOfRun={item.firstOfRun}
        dateLabel={item.dateLabel}
        onRetry={retry}
      />
    ),
    [retry],
  );

  return (
    <Screen edges={['top']} padded={false}>
      <ChatHeader conversationId={conversationId} name={name} onBack={onBack} />

      <View style={{ flex: 1, paddingBottom: kbHeight }}>
        <View style={{ flex: 1, backgroundColor: t.colors.bgBase }}>
          <FlashList
            ref={listRef}
            data={rows}
            inverted
            keyExtractor={m => m.id}
            renderItem={renderItem}
            getItemType={messageItemType}
            onScroll={onScroll}
            scrollEventThrottle={16}
            // Inverted list: the "end" is the TOP, i.e. the oldest bubble on screen. Without this
            // the history simply stopped at one window and nothing could ever load more.
            onEndReached={loadOlder}
            onEndReachedThreshold={0.5}
            contentContainerStyle={LIST_CONTENT_STYLE}
            showsVerticalScrollIndicator={false}
          />
          {showJump ? <JumpToLatest onPress={jumpToLatest} /> : null}
        </View>

        <Composer
          value={text}
          onChangeText={onChangeText}
          onSend={onSend}
          keyboardUp={kbHeight > 0}
        />
      </View>
    </Screen>
  );
}
