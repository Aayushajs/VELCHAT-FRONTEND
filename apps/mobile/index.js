/**
 * @format
 */

// Polyfill crypto.getRandomValues before any crypto (device keys, libsignal) runs.
import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { runQueuedPushActions } from './src/features/notifications';

AppRegistry.registerComponent(appName, () => App);

/**
 * Headless entry for notification actions (ADR 0008, `PushHeadlessService`).
 *
 * Registered here rather than inside a component because it must exist the moment the bundle is
 * evaluated — the service starts a JS runtime with no UI, and a task key registered from a mount
 * effect would not be there yet.
 *
 * This does NOT run for incoming pushes. Those are handled entirely in Kotlin, which is the
 * whole point of ADR 0008: no JS context per message. It runs only when the user deliberately
 * replied to or muted a notification while no app process was alive — work that genuinely needs
 * the user's session and cannot be done from native.
 */
AppRegistry.registerHeadlessTask(
  'VelChatPushTask',
  () => async () => runQueuedPushActions(),
);
