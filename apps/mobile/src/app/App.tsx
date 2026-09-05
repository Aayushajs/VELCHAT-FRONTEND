/**
 * Root application (§L2). Provider order:
 *   SafeAreaProvider > ErrorBoundary > QueryClientProvider > ThemeProvider >
 *   I18nProvider > FeatureFlagsProvider > NavigationContainer
 * Theme choice is persisted via encrypted MMKV (injected here; the theme layer
 * stays infra-free per §M4). WatermelonDB open + crypto init land in MP1/MP2.
 */
import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, type ThemeMode } from '../theme';
import { I18nProvider, isSupportedLanguage, type AppLanguage } from '../i18n';
import { FeatureFlagsProvider, useConnectivity } from '../core';
import {
  queryClient,
  kv,
  KVKeys,
  getNetworkStatus,
  subscribeNetwork,
  warmBackend,
  purgeAllLocalChat,
  getAccountId,
} from '../infra';
import { RootNavigator } from '../navigation';
import { startSync, stopSync, syncEngine } from '../domain/sync';
import { prewarmContacts } from '../features/contacts';
import { backfillInbox } from '../features/chat';
import { getProfile } from '../features/user';
import { useAuthBootstrap } from '../features/auth';
import { ErrorBoundary } from './ErrorBoundary';
import { Splash } from './Splash';
import { bootstrap } from './bootstrap';

function readInitialThemeMode(): ThemeMode {
  // Honour the Settings theme picker's saved choice; default to light (no surprise
  // system flip) until the user opts into dark/system.
  const saved = kv.getString(KVKeys.themeMode);
  return saved === 'light' || saved === 'dark' || saved === 'system'
    ? saved
    : 'light';
}

/** The app-wide language: the user's persisted choice, else English. */
function readInitialLanguage(): AppLanguage {
  const saved = kv.getString(KVKeys.language);
  return saved && isSupportedLanguage(saved) ? saved : 'en';
}

/** Splash until the launch bootstrap resolves the auth state, then the app. */
function Gate(): React.JSX.Element {
  const ready = useAuthBootstrap();
  return ready ? <RootNavigator /> : <Splash />;
}

export default function App(): React.JSX.Element {
  useEffect(() => {
    bootstrap();
    // Wake the (free-tier, hibernating) backend up front so the login path is warm by
    // the time the user reaches it — no 30-50s cold-start timeout on the first request.
    warmBackend();
    // NOTE: this account's own discovery token is now registered SERVER-SIDE at login (auth
    // verifyOtp → directToken), and again as a side-effect of `prewarmContacts` discovery — so
    // we no longer spend a separate client OPRF `evaluate` here (that doubled the rate-limited
    // calls per launch). Findability is covered without it.
    const acc = getAccountId();
    // Warm the New-Chat contacts cache in the background so the list is instant when opened —
    // no per-launch wait (best-effort; no-op without permission or a fresh cache).
    if (acc) void prewarmContacts();
    // Restore the chat list from the server (re-login / reinstall / post-logout wipe) so the
    // inbox isn't empty — re-discovers conversations + pulls their recent messages (best-effort).
    // Give the sync engine a way to name a DM that arrives from someone new (§M3: the domain
    // layer cannot reach into features, so the lookup is injected here).
    syncEngine.setDisplayNameResolver(
      async id => (await getProfile(id)).displayName,
    );
    if (acc) void backfillInbox();
    // Mirror real network reachability into the connectivity store (offline banner + gating).
    const applyOnline = (connected: boolean): void =>
      useConnectivity.getState().setOnline(connected);
    void getNetworkStatus()
      .then(s => applyOnline(s.connected))
      .catch(() => undefined);
    return subscribeNetwork(s => applyOnline(s.connected));
  }, []);

  // MP2 messaging runtime (§L6): the outbox-backed send/receive + reconnect engine. Owns
  // its socket/timers/subscriptions and disposes them on unmount (§M7). Offline-first —
  // the UI observes the DB; the engine only converges it over the network.
  useEffect(() => {
    let disposed = false;
    // One-time cleanup: drop any legacy dev-seed rows (fake chats/messages that used to be
    // written on launch) so the inbox shows ONLY real data — and do it BEFORE the sync
    // engine walks local conversations, so a seeded inbox can't churn 404 backfills.
    const boot = async (): Promise<void> => {
      if (!kv.getBoolean(KVKeys.chatPurged)) {
        await purgeAllLocalChat().catch(() => undefined);
        kv.set(KVKeys.chatPurged, true);
      }
      if (!disposed) startSync();
    };
    void boot();
    return () => {
      disposed = true;
      stopSync();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider
            initialMode={readInitialThemeMode()}
            onModeChange={mode => kv.set(KVKeys.themeMode, mode)}
          >
            <I18nProvider
              initialLanguage={readInitialLanguage()}
              onLanguageChange={lang => kv.set(KVKeys.language, lang)}
            >
              <FeatureFlagsProvider>
                <Gate />
              </FeatureFlagsProvider>
            </I18nProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
