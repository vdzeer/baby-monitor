import { getRandomValues } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import BabyNative from '../modules/baby-native';
import {
  loadMonitorSecrets,
  loadParentSecrets,
  MonitorCredentials,
  ParentCredentials,
} from './session/secure/credentials';
import { newDeviceId, type Random } from './session/secure/handshake';

/** Native CSPRNG (SecRandomCopyBytes) for nonces, CPace scalars and X25519 keys. */
export const random: Random = (length) => getRandomValues(new Uint8Array(length));

/**
 * In the Keychain, readable after the first unlock since boot (the baby unit keeps working with the
 * screen locked), and ThisDeviceOnly: never restored onto another device (a restore of this same device
 * from its own backup may bring them back, see README "Security notes").
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
const MONITOR_KEY = 'moonbeam.monitor';
const PARENT_KEY = 'moonbeam.parent';

export type Secrets = { monitor: MonitorCredentials; parent: ParentCredentials };

// The synchronous calls on purpose: Expo runs every module's async functions on one shared queue,
// and a call that waits there (expo-notifications waits for the user to answer its permission
// prompt) would hold back saving a new pairing key. Keychain access itself takes milliseconds.

/** The stored value, null if there is none, or `unreadable` if the Keychain failed. */
function read(key: string): string | null | 'unreadable' {
  try {
    return SecureStore.getItem(key, OPTIONS);
  } catch {
    return 'unreadable';
  }
}

/** False if the Keychain refused; the caller keeps working from memory. */
function write(key: string, value: object): boolean {
  try {
    SecureStore.setItem(key, JSON.stringify(value), OPTIONS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads both roles' secrets (a device can switch roles), creating them on first launch. The first
 * launch after updating from version 1 counts as one: its code is not taken over (see credentials.ts).
 * `freshInstall`: Keychain items outlive a deleted app; a new installation starts over with new ones,
 * as deleting the app always did.
 */
export function loadSecrets(freshInstall: boolean): Secrets {
  const storedMonitor = freshInstall ? null : read(MONITOR_KEY);
  const storedParent = freshInstall ? null : read(PARENT_KEY);
  // If the Keychain can't be read, work from memory this time rather than overwrite what is there.
  const monitorReadable = storedMonitor !== 'unreadable';
  const parentReadable = storedParent !== 'unreadable';
  const monitor = loadMonitorSecrets(
    monitorReadable ? storedMonitor : null,
    () => BabyNative.randomDigits(6),
    () => newDeviceId(random),
  );
  const parent = loadParentSecrets(parentReadable ? storedParent : null, () => newDeviceId(random));
  if (monitorReadable && monitor.changed) write(MONITOR_KEY, monitor.secrets);
  if (parentReadable && parent.changed) write(PARENT_KEY, parent.secrets);

  return {
    monitor: new MonitorCredentials(monitor.secrets, (secrets) => monitorReadable && write(MONITOR_KEY, secrets)),
    parent: new ParentCredentials(parent.secrets, (secrets) => parentReadable && write(PARENT_KEY, secrets)),
  };
}
