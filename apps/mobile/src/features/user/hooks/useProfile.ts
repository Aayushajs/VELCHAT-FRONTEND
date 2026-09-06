/**
 * Profile hooks. `useProfileGate` decides whether the first-run profile sheet must
 * open — a local flag short-circuits it after completion, otherwise it checks the
 * backend once (a fresh OTP account has no profile → 404 → needs setup). `useSaveProfile`
 * persists the directory profile. Both read the account id from infra (no cross-feature
 * import); it's already set by the time the app reaches home.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image } from 'react-native';
import type { Image as CroppedImage } from 'react-native-image-crop-picker';
import { useConnectivity } from '../../../core';
import {
  backoffMs,
  getAccountId,
  isAppError,
  kv,
  KVKeys,
  useKVString,
} from '../../../infra';
import {
  getProfile,
  updateProfile,
  setAccountEmail,
  initUpload,
  uploadMediaFile,
  getMediaUrl,
  type Profile,
} from '../api/userApi';
import { publishProfileChanged } from '../../../core';

// Re-exported so feature UI gets haptics through the feature layer (UI must not
// import infra directly — layer boundaries §M3).
export { hapticTick } from '../../../infra';

// Bumped every time the avatar is removed. A profile reload started BEFORE a removal
// (e.g. a slow cold-start fetch in flight) must not resurrect the just-deleted photo,
// so reload snapshots this at the start and bails out of re-caching if it changed.
let avatarRemovalEpoch = 0;

/**
 * How many times the profile read is retried before giving up for this mount. Six full-jitter
 * attempts span well past a free-tier cold start without becoming a poll against a backend that
 * is genuinely down (coming back online triggers a fresh attempt regardless).
 */
const MAX_PROFILE_RETRIES = 6;

type CropPicker = typeof import('react-native-image-crop-picker').default;

/**
 * Lazily resolve the native cropper. On the New Architecture the module throws at
 * import when its native side isn't in the binary yet (i.e. after adding the dep but
 * before a rebuild). Loading it lazily + guarded means that only the "pick photo"
 * action fails softly with a clear message — the rest of the app keeps working.
 */
function loadCropPicker(): CropPicker | null {
  try {
    return require('react-native-image-crop-picker').default as CropPicker;
  } catch {
    return null;
  }
}

export function useProfileGate(): {
  needsSetup: boolean;
  markComplete: () => void;
} {
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    const accountId = getAccountId();
    if (!accountId) return undefined;
    // Email is the completion signal — it's required and (until a backend email-attach
    // endpoint exists) lives only in the local mirror, so a reinstall can lose it. If
    // we still have it, the profile is set up; never prompt.
    if (kv.getString(KVKeys.email)) {
      kv.set(KVKeys.profileComplete, true);
      return undefined;
    }

    // No email yet → we WILL prompt (even if a name already exists). Load the backend
    // profile first so the sheet can pre-fill the existing name/about and the user only
    // needs to add the missing email — coming up from the bottom, WhatsApp-style.
    let active = true;
    const check = async (): Promise<void> => {
      try {
        const profile = await getProfile(accountId);
        if (profile?.displayName && profile.displayName.trim() !== '') {
          kv.set(KVKeys.displayName, profile.displayName);
        }
        if (profile?.about) kv.set(KVKeys.about, profile.about);
      } catch {
        // No profile yet (404) or a transient error → still prompt to set it up.
      }
      if (active) setNeedsSetup(true);
    };
    void check();
    return () => {
      active = false;
    };
  }, []);

  const markComplete = useCallback(() => {
    kv.set(KVKeys.profileComplete, true);
    setNeedsSetup(false);
  }, []);

  return { needsSetup, markComplete };
}

/**
 * Locally-mirrored profile summary — REACTIVE. Backed by the encrypted MMKV mirror, it
 * re-renders every consumer (header, Settings, Profile) the instant a photo is picked or
 * a field saved. Zero network on the render path; the UI never waits (§M0).
 */
export function useProfileSummary(): {
  displayName: string | null;
  email: string | null;
  phone: string | null;
  about: string | null;
  avatarUri: string | null;
  /** Effective avatar to render: the locally-picked photo, else the cached server URL. */
  avatar: string | null;
  loginAt: string | null;
  memberSince: string | null;
} {
  const avatarUri = useKVString(KVKeys.avatarUri) ?? null;
  const avatarUrl = useKVString(KVKeys.avatarUrl) ?? null;
  return {
    displayName: useKVString(KVKeys.displayName) ?? null,
    email: useKVString(KVKeys.email) ?? null,
    phone: useKVString(KVKeys.phone) ?? null,
    about: useKVString(KVKeys.about) ?? null,
    avatarUri,
    avatar: avatarUri ?? avatarUrl,
    loginAt: useKVString(KVKeys.loginAt) ?? null,
    memberSince: useKVString(KVKeys.memberSince) ?? null,
  };
}

/**
 * Load the authoritative profile from the backend once (§B3) and mirror it locally so
 * the reactive summary reflects the server truth. Resolves the avatar's mediaId to a
 * signed URL for display when there's no local picked copy (e.g. a fresh install).
 * Offline-first: any failure is non-blocking — the mirror already rendered instantly.
 */
export function useProfileDetails(): {
  loading: boolean;
  error: string | null;
  remoteAvatarUrl: string | null;
  reload: () => Promise<void>;
} {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remoteAvatarUrl, setRemoteAvatarUrl] = useState<string | null>(null);
  /** Consecutive failures — drives the retry backoff below. Reset on success. */
  const attempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);
  const online = useConnectivity(c => c.online);

  const reload = useCallback(async (): Promise<void> => {
    const accountId = getAccountId();
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // Snapshot the removal epoch: if the user removes their photo while this fetch is
    // in flight, we must NOT write the (now stale) server URL back and bring it back.
    const startEpoch = avatarRemovalEpoch;
    try {
      const profile = await getProfile(accountId);
      if (profile.displayName) kv.set(KVKeys.displayName, profile.displayName);
      if (profile.about !== undefined)
        kv.set(KVKeys.about, profile.about ?? '');
      if (profile.avatarMediaId && avatarRemovalEpoch === startEpoch) {
        try {
          const { url } = await getMediaUrl(profile.avatarMediaId);
          // Re-check AFTER the media round-trip too (a removal may land meanwhile).
          if (avatarRemovalEpoch !== startEpoch) return;
          setRemoteAvatarUrl(url);
          // Cache it (reactive) → the header/Settings/Profile show the photo instantly,
          // here and on the next launch, without waiting for this round-trip again.
          kv.set(KVKeys.avatarUrl, url);
          // Pull the BYTES into the native image cache now, while the backend is reachable.
          // The URL is a ~10-minute signed link, so when the API later goes down (or the link
          // expires) there is no way to re-sign it — but the decoder can still serve this exact
          // URL from its own disk cache, which is what keeps the photo on screen offline.
          Image.prefetch(url).catch(() => undefined);
        } catch {
          // A missing signed URL just means we keep whatever local copy we have.
        }
      } else {
        // No server avatar (never set / removed) → drop any stale cached URL.
        setRemoteAvatarUrl(null);
        kv.delete(KVKeys.avatarUrl);
      }
      attempts.current = 0; // a clean read — stop retrying
    } catch (e) {
      setError(
        isAppError(e) ? e.message : 'Could not refresh your profile just now.',
      );
      /**
       * RETRY. This fetch is what resolves the avatar's signed URL, and it used to run exactly
       * once per mount: one failure meant no photo for the whole session, and the photo only
       * "appeared after restarting the app" because the next launch happened to succeed. The
       * backend is a hibernating free-tier instance (hence `warmBackend()` at startup), so the
       * first request after sign-in very often loses that 30-50 s cold-start race.
       *
       * Full-jitter backoff, capped attempts — enough to ride out a cold start without turning a
       * genuinely-down backend into a polling loop. The local mirror keeps rendering throughout,
       * so this is never on the render path.
       */
      attempts.current += 1;
      if (attempts.current <= MAX_PROFILE_RETRIES && !disposed.current) {
        const delay = backoffMs(attempts.current);
        if (retryTimer.current !== null) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          if (!disposed.current) void reload();
        }, delay);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    disposed.current = false;
    void reload();
    return () => {
      // §M7: the retry timer is owned by this hook and must not outlive it.
      disposed.current = true;
      if (retryTimer.current !== null) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [reload]);

  // Coming back online is the strongest possible signal that a failed fetch is now worth
  // repeating — far better than waiting out the remaining backoff.
  useEffect(() => {
    if (online && attempts.current > 0) void reload();
  }, [online, reload]);

  return { loading, error, remoteAvatarUrl, reload };
}

export function useSaveProfile(): {
  save: (patch: Partial<Profile>, email?: string) => Promise<boolean>;
  saving: boolean;
  error: string | null;
} {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (patch: Partial<Profile>, email?: string): Promise<boolean> => {
      const accountId = getAccountId();
      if (!accountId) {
        setError('Please sign in to continue.');
        return false;
      }
      setSaving(true);
      setError(null);
      try {
        await updateProfile(accountId, patch);
        // Tell every cache holding this account's profile that it just moved. Without this the
        // new photo is on the server and in the local mirror, while the chat list, chat headers
        // and contact rows keep serving the copy they resolved earlier — until each TTL expires
        // or the app is killed. That is the whole "it only changes after I reopen the app" bug.
        publishProfileChanged(accountId);
        // Mirror name/about locally so Settings + Profile render instantly (no fetch).
        if (patch.displayName) kv.set(KVKeys.displayName, patch.displayName);
        if (patch.about !== undefined) kv.set(KVKeys.about, patch.about);
        // Email is a VERIFIED identifier (auth-service), not a directory field. Persist it
        // server-side so it survives logout/login (restored via getAccountInfo → no more
        // re-prompting) and is globally unique — a duplicate throws 409, surfaced below.
        if (email) {
          const { email: saved } = await setAccountEmail(email);
          kv.set(KVKeys.email, saved);
        }
        return true;
      } catch (e) {
        setError(
          isAppError(e)
            ? e.message
            : 'Could not save your profile. Please try again.',
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return { save, saving, error };
}

/**
 * Pick an avatar from the gallery and upload it (init → multipart PUT). Exposes the
 * local uri for an instant optimistic preview + the reserved mediaId to attach to the
 * profile on save. Failures are surfaced but never block finishing the form (the
 * default placeholder simply stays).
 */
export function useAvatarUpload(): {
  /** Resolves to the uploaded mediaId (to attach to the profile), or null on cancel/fail. */
  pick: () => Promise<string | null>;
  localUri: string | null;
  mediaId: string | null;
  uploading: boolean;
  error: string | null;
} {
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(async (): Promise<string | null> => {
    const accountId = getAccountId();
    if (!accountId) return null;
    const cropper = loadCropPicker();
    if (!cropper) {
      // Native module absent → the app hasn't been rebuilt since adding the cropper.
      setError("Couldn't open the photo editor right now. Please try again.");
      return null;
    }
    // Open the gallery straight into a circular crop UI (WhatsApp/Instagram-style),
    // square-forced to 512² JPEG so avatars are consistent and light to upload.
    let image: CroppedImage;
    try {
      image = await cropper.openPicker({
        mediaType: 'photo',
        cropping: true,
        cropperCircleOverlay: true,
        width: 512,
        height: 512,
        compressImageQuality: 0.85,
        forceJpg: true,
        hideBottomControls: true,
        showCropGuidelines: false,
      });
    } catch (e) {
      // Backing out of the picker/cropper is a normal cancel, not an error.
      if ((e as { code?: string })?.code === 'E_PICKER_CANCELLED') return null;
      setError("Couldn't open your photos. Please try again.");
      return null;
    }
    if (!image?.path) return null;
    setLocalUri(image.path);
    // Persist the local uri so the header + Settings show the photo immediately and
    // across launches on this device (the server copy rides on avatarMediaId).
    kv.set(KVKeys.avatarUri, image.path);
    setError(null);
    setUploading(true);
    let result: string | null = null;
    try {
      const mime = image.mime ?? 'image/jpeg';
      const { mediaId: id, uploadPath } = await initUpload(accountId, mime);
      await uploadMediaFile(uploadPath, {
        uri: image.path,
        name: image.filename ?? 'avatar.jpg',
        type: mime,
      });
      setMediaId(id);
      result = id;
    } catch (e) {
      setError(
        isAppError(e) ? e.message : 'Photo upload failed. You can try again.',
      );
      setMediaId(null);
    } finally {
      setUploading(false);
    }
    return result;
  }, []);

  return { pick, localUri, mediaId, uploading, error };
}

/**
 * Pick + upload + attach an avatar to the directory profile in one call. Wraps
 * `useAvatarUpload` and, once the upload yields a mediaId, PUTs it onto the profile —
 * so changing the photo from anywhere (Profile page OR the long-press peek) fully
 * persists, and the reactive mirror shows it everywhere at once.
 */
export function useAvatarPicker(): {
  pick: () => Promise<void>;
  remove: () => Promise<void>;
  uploading: boolean;
  localUri: string | null;
  error: string | null;
} {
  const { pick: uploadPick, localUri, uploading, error } = useAvatarUpload();
  const { save } = useSaveProfile();

  // Attach INLINE in the async flow (not via a mediaId useEffect): the long-press peek
  // calls onClose() and unmounts the instant it starts the pick, so a post-mount effect
  // would never fire and the avatarMediaId would never reach the server. Both `uploadPick`
  // and `save` are stable callbacks, so this keeps working past the component's unmount.
  const pick = useCallback(async (): Promise<void> => {
    const id = await uploadPick();
    if (id) await save({ avatarMediaId: id });
  }, [uploadPick, save]);

  // Remove the profile photo. Clear the local mirror first (reactive → the photo
  // disappears from the header/Settings/Profile at once), then clear it on the server
  // by sending an empty mediaId — the user-service COALESCE stores '' and getProfile
  // returns it falsy, so it stays cleared across launches and other devices.
  const remove = useCallback(async (): Promise<void> => {
    // Supersede any profile reload in flight so it can't write the old URL back.
    avatarRemovalEpoch += 1;
    // Snapshot before clearing so we can put it back if the server clear fails — the photo
    // is still on the server then, so restoring keeps the UI truthful (no silent revert).
    const prevUri = kv.getString(KVKeys.avatarUri);
    const prevUrl = kv.getString(KVKeys.avatarUrl);
    kv.delete(KVKeys.avatarUri);
    kv.delete(KVKeys.avatarUrl);
    const ok = await save({ avatarMediaId: '' });
    if (!ok) {
      if (prevUri) kv.set(KVKeys.avatarUri, prevUri);
      if (prevUrl) kv.set(KVKeys.avatarUrl, prevUrl);
    }
  }, [save]);

  return { pick, remove, uploading, localUri, error };
}
