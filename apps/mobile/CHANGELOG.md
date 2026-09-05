# @velchat/mobile

## 1.0.0

### Major Changes

- 1e89077: change more fetures and fix bug

## 0.5.0

### Minor Changes

- 2c0693f: MP2 foundation — offline-first chat:

  - **WatermelonDB** as the local DB / UI source of truth (ADR-0005). Schema v1 with the
    core tables (§L5): conversations, messages, receipts, conversation_members, users,
    outbox, drafts, upload_jobs, download_jobs — each indexed for its queries. JSI adapter
    (off-thread reads), legacy decorators, jest-stubbed.
  - **Chats list** — WhatsApp-style rows on **FlashList** (ADR-0006) that OBSERVE the DB
    (pinned → most-recent, unread pills, instant open). Replaces the Chats placeholder; a
    dev seed fills it until the MP2 sync engine feeds real conversations.

  - **Chat screen** — tap a row → the conversation: a reversed FlashList of message bubbles
    (mine right / theirs left, ✓/✓✓ ticks) reading the DB, and a keyboard-aware composer
    that sends OPTIMISTICALLY (writes the DB → the bubble appears instantly; the MP2 outbox
    transmits + reconciles later). Dev-seeded messages until sync lands.

  Needs a native rebuild (WatermelonDB + FlashList are native modules).

- 1910659: Profile & connectivity pass:

  - WhatsApp-style **Profile page** (new screen): large avatar with camera badge + circular
    crop, inline-editable name/about, read-only phone/email/last-login rows.
  - **Settings**: flat profile header that opens the Profile page + long-press **peek**
    popup (frosted-glass "water bubble" actions via a new `FrostedCircle`/`GlassBubble`),
    refined top-bar spacing, top-bar actions (search/scan/edit).
  - **Welcome**: language selector pill → bottom-sheet dropdown (en/hi/ar).
  - **Reactive profile mirror** — avatar/name update everywhere (header, Settings, Profile)
    the instant a photo is picked or a field saved (`useKVString`), offline-first.
  - **Correctness**: normalize the user-service profile read (snake_case → camelCase) so
    name + avatar actually resolve; persist the phone on OTP verify and stamp `loginAt`;
    clear the mirrored profile on sign-out.
  - **Media**: circular avatar crop via `react-native-image-crop-picker` (ADR-0003),
    real frosted-glass blur via `@react-native-community/blur` (ADR-0004).
  - **Account snapshot**: Profile page now shows SERVER-truth phone/email + **member since**
    (account created) and **last login** (last active), via a new read-only backend
    `GET /auth/account`, mirrored offline-first. Graceful if the endpoint isn't deployed yet.
  - **Ops / connectivity**: point stage `WS_URL` at the realtime-gateway host; **warm the
    backend on app launch** so a hibernating free-tier service doesn't cause a cold-start
    timeout on first request.

## 0.4.0

### Minor Changes

- b889c55: Home shell + product polish. A swipeable 4-tab home (Chats / Updates / Communities / Calls) on a
  native pager with a WhatsApp-style shared header (VelChat wordmark, profile, search, a flight-mode
  offline toggle, and an overflow menu). A first-run profile-setup bottom sheet (name + about), a
  premium Settings screen (theme picker light/dark/system + persisted, language, account rows,
  sign-out), a crisp `react-native-svg` icon system, runtime permissions (camera/mic/contacts/
  bluetooth), a flight/offline mode with an offline banner + network gating, and a dev-only readable
  network trace in Metro. Onboarding polished (Welcome → Notifications → SignIn → phone/OTP sheet).

## 0.3.0

### Minor Changes

- c0ed9d8: MP1 auth (start): EnterPhone + Reverse-OTP verify screens (themed), the AuthMachine
  (`signed_out|onboarding|verifying|provisioning|active|locked|recovering`) as a Zustand store,
  the auth API layer over the axios client, and an Ed25519 device identity key (@noble, SPKI/DER
  public key at register; challenge signing) with a CSPRNG polyfill. Welcome now routes to the phone
  flow.

## 0.2.0

### Minor Changes

- 3ab5c3e: Networking layer (§M7/§L3): Axios API client with request interceptor (Bearer + tenant + request-id + client-version), response envelope-unwrap, single-flight 401 refresh, backoff retry + 429 Retry-After, and a typed `AppError`. Feature-flags loader moved off `fetch` to Axios.

## 0.1.0

### Minor Changes

- 34ef884: MBOOT-0 + MP0 foundation and onboarding.

  - Foundation: pnpm + Turborepo monorepo, RN 0.86 (New Arch/Hermes), strict TS, `eslint-plugin-boundaries` layer rules, no-AsyncStorage / no-console gates.
  - Design system: Poppins type scale, tokens, theme (light/dark + MMKV persistence), primitives, `FadeInUp` motion.
  - App shell: navigation (Welcome → Notifications → AppTabs), i18n (en + ar), observability (pino + PII redaction), feature-flags/kill-switch, bootstrap sequence.
  - Onboarding: Welcome (orbit hero) and Notifications (phone-mock hero) screens with staggered animations and floating pop-out pill CTAs.
  - Repo: husky + commitlint (Conventional Commits) + Changesets + Prettier + CI/release workflows.
