/**
 * features/contacts — feature slice. Shape: ui/ model/ api/ hooks/ db/. Only this index is public.
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export { useContacts } from './hooks/useContacts';
export type { Contact } from './api/contactsApi';
export {
  useDeviceContacts,
  prewarmContacts,
  clearContactsDiscoveryCache,
} from './hooks/useDeviceContacts';
export type { DeviceContactsStatus } from './hooks/useDeviceContacts';
export type { VelchatContact, InviteContact } from './model/contactLists';
export { useNumberSearch } from './hooks/useNumberSearch';
