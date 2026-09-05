/**
 * features/user — feature slice. Shape: ui/ api/ hooks/. Only this index is public.
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export { ProfileSetupSheet } from './ui/ProfileSetupSheet';
export { ProfilePhotoViewerModal } from './ui/ProfilePhotoViewerModal';
export type { ProfilePhotoViewerModalProps } from './ui/ProfilePhotoViewerModal';
export {
  useProfileGate,
  useProfileSummary,
  useProfileDetails,
  useSaveProfile,
  useAvatarUpload,
  useAvatarPicker,
} from './hooks/useProfile';
// Directory reads reused cross-slice (e.g. startDm resolves a peer's display name).
export { getProfile, getMediaUrl, clearProfileCache } from './api/userApi';
export type { Profile } from './api/userApi';
export {
  useContactAvatar,
  clearContactAvatarCache,
} from './hooks/useContactAvatar';
