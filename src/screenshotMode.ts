import AsyncStorage from '@react-native-async-storage/async-storage';
import { LogBox } from 'react-native';

/**
 * Development builds only: staging for App Store screenshots, since a simulator can't be tapped
 * from a script. 'settings' opens the settings sheet once live.
 * Release builds never read it.
 */
export let screenshotMode: 'plain' | 'settings' | null = null;

export async function loadScreenshotMode() {
  if (!__DEV__) return;
  const mode = await AsyncStorage.getItem('screenshot').catch(() => null);
  if (mode !== 'plain' && mode !== 'settings') return;
  screenshotMode = mode;
  // No permission prompts or developer warnings in the picture.
  LogBox.ignoreAllLogs(true);
}
