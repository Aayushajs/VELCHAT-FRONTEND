/**
 * Home header (§F1) — shared above the four tabs, WhatsApp-style, and it adapts per
 * tab (focused tab from the TabBar via `useActiveTab`). Chats shows the VelChat
 * wordmark + a search bar, and its right cluster is profile · camera · offline · ⋮.
 * The other tabs show their name + their own action icons (Updates: search + downloads
 * · Communities: mail · Calls: search + meeting) with the offline toggle tucked into
 * the ⋮ menu, and NO profile. Themed, safe-area aware.
 */
import React, { useState, useRef, useEffect } from 'react';
import { View, Pressable, Image, Animated, AppState } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import {
  Text,
  SearchIcon,
  CameraIcon,
  DownloadIcon,
  MailIcon,
  VideoIcon,
  MoreIcon,
  UserIcon,
  SpinningRing,
  type IconProps,
} from '../design-system';
import { useConnectivity, useActiveTab } from '../core';
import { useProfileSummary } from '../features/user';
import { HeaderMenu, type HeaderMenuItem } from './HeaderMenu';
import { ProfilePeek } from './ProfilePeek';
import type { RootStackParamList } from './types';
import VELCHAT_ICON from '../design-system/assets/velchat-icon.png';

// The rotating "active" halo around the avatar — a lively green even in the B&W theme.
const RING_GREEN = '#25D366';

interface Action {
  key: string;
  Icon: React.FC<IconProps>;
  label: string;
  onPress: () => void;
}

function IconButton({
  icon: Icon,
  onPress,
  label,
  active = false,
}: {
  icon: React.FC<IconProps>;
  onPress: () => void;
  label: string;
  active?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 38,
        height: 40,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? `${t.colors.brandFrom}1F` : 'transparent',
        opacity: pressed ? 0.55 : 1,
      })}
    >
      <Icon
        size={22}
        color={active ? t.colors.brandFrom : t.colors.textPrimary}
        strokeWidth={2}
      />
    </Pressable>
  );
}

// Rotating search hint — cycles "messages · files · media · AI search" with a fade,
// so the bar tells you it searches everything (auto-updates every couple of seconds).
const SEARCH_HINTS = [
  'hintMessages',
  'hintFiles',
  'hintMedia',
  'hintAi',
] as const;

function SearchHint(): React.JSX.Element {
  const t = useTheme();
  const { t: tr } = useTranslation();
  const [i, setI] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      Animated.timing(fade, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => {
        setI(x => (x + 1) % SEARCH_HINTS.length);
        Animated.timing(fade, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }).start();
      });
    };
    // Run the cycling hint ONLY while foregrounded — no perpetual 2.4s JS wake +
    // re-render while the app is backgrounded (§M13 overnight / §R6 battery).
    const start = (): void => {
      if (id === null) id = setInterval(tick, 2400);
    };
    const stop = (): void => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', s =>
      s === 'active' ? start() : stop(),
    );
    return () => {
      stop();
      sub.remove();
    };
  }, [fade]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
      <Text variant="body" color="secondary">
        {`${tr('header.search')} `}
      </Text>
      <Animated.Text
        numberOfLines={1}
        style={{
          flex: 1,
          opacity: fade,
          fontFamily: t.typography.body.fontFamily,
          fontSize: 16,
          color: t.colors.textTertiary,
        }}
      >
        {tr(`header.${SEARCH_HINTS[i]}`)}
      </Animated.Text>
    </View>
  );
}

export function HomeHeader(): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { t: tr } = useTranslation();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const flightMode = useConnectivity(s => s.flightMode);
  const toggleFlight = useConnectivity(s => s.toggleFlightMode);
  const activeTab = useActiveTab(s => s.name);
  const { displayName, avatar } = useProfileSummary();
  const initial = (displayName ?? '').trim().charAt(0).toUpperCase();
  const [menuOpen, setMenuOpen] = useState(false);
  const [peekOpen, setPeekOpen] = useState(false);

  const openSettings = (): void => navigation.navigate('Settings');
  const openProfile = (): void => navigation.navigate('Profile');
  const openSearch = (): void => navigation.navigate('Search');
  const noop = (): void => undefined;
  const isChats = activeTab === 'Chats';

  // Non-Chats action icons (Chats builds its cluster inline: profile · camera · offline).
  const actions: Action[] =
    activeTab === 'Updates'
      ? [
          {
            key: 'search',
            Icon: SearchIcon,
            label: tr('header.search'),
            onPress: openSearch,
          },
          {
            key: 'download',
            Icon: DownloadIcon,
            label: tr('header.downloads'),
            onPress: noop,
          },
        ]
      : activeTab === 'Communities'
        ? [
            {
              key: 'mail',
              Icon: MailIcon,
              label: tr('header.mail'),
              onPress: noop,
            },
          ]
        : activeTab === 'Calls'
          ? [
              {
                key: 'search',
                Icon: SearchIcon,
                label: tr('header.search'),
                onPress: noop,
              },
              {
                key: 'meeting',
                Icon: VideoIcon,
                label: tr('header.meeting'),
                onPress: noop,
              },
            ]
          : [];

  // Offline toggle lives in the overflow menu on every tab (no header icon for now).
  const menuItems: HeaderMenuItem[] = [
    {
      label: flightMode ? tr('header.goOnline') : tr('header.goOffline'),
      onPress: toggleFlight,
    },
    { label: tr('header.newGroup'), onPress: noop },
    { label: tr('header.starred'), onPress: noop },
    { label: tr('tabs.settings'), onPress: openSettings },
  ];

  const profile = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tr('profile.pageTitle')}
      onPress={openProfile}
      onLongPress={() => setPeekOpen(true)}
      delayLongPress={220}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 36,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View
        style={{
          width: 32,
          height: 32,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SpinningRing
          size={33}
          color={RING_GREEN}
          thickness={2.1}
          durationMs={6000}
        />
        <View
          style={{
            width: 25,
            height: 25,
            borderRadius: 13,
            backgroundColor: t.colors.bgSubtle,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {avatar ? (
            <Image
              source={{ uri: avatar }}
              style={{ width: 25, height: 25 }}
              resizeMode="cover"
            />
          ) : initial ? (
            <Text
              variant="label"
              style={{ color: t.colors.textPrimary, fontSize: 12 }}
            >
              {initial}
            </Text>
          ) : (
            <UserIcon
              size={15}
              color={t.colors.textSecondary}
              strokeWidth={2}
            />
          )}
        </View>
      </View>
    </Pressable>
  );

  return (
    <View style={{ paddingTop: insets.top, backgroundColor: t.colors.bgBase }}>
      {/* Row 1 — title (left) + right cluster */}
      <View
        style={{
          height: 56,
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: t.spacing.lg,
          paddingRight: t.spacing.xs,
        }}
      >
        <View style={{ flex: 1 }}>
          {isChats ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Image
                source={VELCHAT_ICON}
                accessibilityLabel="VelChat"
                style={{
                  width: 31,
                  height: 31,
                  borderRadius: 8,
                  marginRight: 9,
                }}
                resizeMode="contain"
              />
              <Text
                variant="title"
                style={{ fontSize: 22, color: t.colors.textPrimary }}
              >
                VelChat
              </Text>
            </View>
          ) : (
            <Text variant="title" numberOfLines={1} style={{ fontSize: 22 }}>
              {tr(`tabs.${activeTab.toLowerCase()}`)}
            </Text>
          )}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {isChats ? (
            <>
              {profile}
              <View style={{ width: t.spacing.xs }} />
              <IconButton
                icon={CameraIcon}
                onPress={noop}
                label={tr('header.camera')}
              />
            </>
          ) : (
            actions.map(a => (
              <IconButton
                key={a.key}
                icon={a.Icon}
                onPress={a.onPress}
                label={a.label}
              />
            ))
          )}
          <IconButton
            icon={MoreIcon}
            onPress={() => setMenuOpen(true)}
            label={tr('header.more')}
          />
        </View>
      </View>

      {/* Row 2 — a full-width search bar (Chats only, WhatsApp-style) */}
      {isChats ? (
        <View
          style={{
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.xxs,
            paddingBottom: t.spacing.sm,
          }}
        >
          <Pressable
            accessibilityRole="search"
            accessibilityLabel={tr('header.search')}
            onPress={openSearch}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: t.spacing.sm,
              height: 45,
              borderRadius: t.radius.pill,
              backgroundColor: t.colors.bgSubtle,
              paddingHorizontal: t.spacing.sm,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <SearchIcon
              size={19}
              color={t.colors.textSecondary}
              strokeWidth={2}
            />
            <SearchHint />
          </Pressable>
        </View>
      ) : (
        <View style={{ height: t.spacing.xs }} />
      )}

      <HeaderMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={menuItems}
      />

      {/* Mounted only while open — otherwise its profile hooks (7 reactive MMKV reads +
          the avatar picker) would run idle on every header render. */}
      {peekOpen ? (
        <ProfilePeek visible onClose={() => setPeekOpen(false)} />
      ) : null}
    </View>
  );
}
