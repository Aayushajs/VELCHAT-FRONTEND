/**
 * Chat-list render correctness (§F2).
 *
 * 1. A memoised row must re-render when its OWN fields change. WatermelonDB mutates its
 *    cached model in place and re-emits the same object reference, and FlashList's ViewHolder
 *    memo also compares `prevProps.item === nextProps.item` — so a row keyed on the model
 *    would keep showing a stale unread badge / preview forever.
 * 2. The empty state must never render before the first DB emission (it used to flash "No
 *    chats yet" on every cold start / tab mount).
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../../../../theme';
import type { Conversation } from '../../../../infra';
import { ChatsList, ConversationRow } from '../ChatsList';
import {
  toConversationRow,
  type ConversationsState,
} from '../../hooks/useConversations';

const mockUseConversations = jest.fn<ConversationsState, []>();

jest.mock('../../hooks/useConversations', () => ({
  ...jest.requireActual('../../hooks/useConversations'),
  useConversations: () => mockUseConversations(),
}));

// The row's async side-hooks (peer lookup → DB, avatar → network) are not under test here
// and would settle outside `act`.
jest.mock('../../hooks/useConversationPeer', () => ({
  useConversationPeer: () => undefined,
}));
jest.mock('../../../user', () => ({ useContactAvatar: () => undefined }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

const NOW = new Date(2026, 7, 2, 12, 0).getTime();

function withTheme(node: React.ReactNode): React.JSX.Element {
  return <ThemeProvider initialMode="light">{node}</ThemeProvider>;
}

function fakeModel(): Conversation {
  return {
    id: 'c1',
    type: 'dm',
    name: 'Ada Lovelace',
    lastMessagePreview: 'see you at 6',
    lastMessageAt: NOW,
    unreadCount: 3,
    isPinned: false,
  } as unknown as Conversation;
}

function rowProps(
  m: Conversation,
): React.ComponentProps<typeof ConversationRow> {
  const vm = toConversationRow(m, NOW);
  return {
    id: vm.id,
    name: vm.name,
    preview: vm.preview,
    time: vm.time,
    unreadCount: vm.unread,
    isDm: vm.type === 'dm',
    peerAvatarUrl: vm.peerAvatarUrl,
    onOpen: () => undefined,
  };
}

describe('ConversationRow', () => {
  it('re-renders when the underlying model is mutated IN PLACE', () => {
    const m = fakeModel();
    const { rerender } = render(
      withTheme(<ConversationRow {...rowProps(m)} />),
    );
    expect(screen.getByText('3')).toBeOnTheScreen();
    expect(screen.getByText('see you at 6')).toBeOnTheScreen();

    // Opening the chat clears unread and a new message rewrites the preview — both land as
    // in-place writes on the SAME model object, which is the trap this row must survive.
    const mutable = m as unknown as {
      unreadCount: number;
      lastMessagePreview: string;
    };
    mutable.unreadCount = 0;
    mutable.lastMessagePreview = 'on my way';

    rerender(withTheme(<ConversationRow {...rowProps(m)} />));

    expect(screen.queryByText('3')).toBeNull(); // badge gone
    expect(screen.getByText('on my way')).toBeOnTheScreen();
    expect(screen.queryByText('see you at 6')).toBeNull();
  });

  it('caps the unread badge at 99+', () => {
    const m = fakeModel();
    (m as unknown as { unreadCount: number }).unreadCount = 120;
    render(withTheme(<ConversationRow {...rowProps(m)} />));
    expect(screen.getByText('99+')).toBeOnTheScreen();
  });
});

describe('ChatsList empty state', () => {
  it('renders nothing until the first DB emission', () => {
    mockUseConversations.mockReturnValue({ rows: [], loaded: false });
    render(withTheme(<ChatsList />));
    expect(screen.queryByText('No chats yet')).toBeNull();
  });

  it('renders the empty state once loaded with no chats', () => {
    mockUseConversations.mockReturnValue({ rows: [], loaded: true });
    render(withTheme(<ChatsList />));
    expect(screen.getByText('No chats yet')).toBeOnTheScreen();
  });
});
