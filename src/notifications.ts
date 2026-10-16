import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function requestAlertPermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || !current.canAskAgain) return;
  await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
}

/**
 * A local notification from the parent app itself: it keeps running in the background while
 * it plays the baby unit's sound, so no push server is involved.
 */
export function notifyInBackground(title: string, body: string, identifier?: string) {
  // On screen, the parent already sees what happened.
  if (AppState.currentState === 'active') return;
  Notifications.scheduleNotificationAsync({
    // A notification with the same identifier replaces the earlier one instead of piling up.
    identifier,
    // Time-sensitive alerts get through Focus modes such as Sleep.
    content: { title, body, sound: true, interruptionLevel: 'timeSensitive' },
    trigger: null,
  }).catch(() => {});
}
