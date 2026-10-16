import { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import BabyNative from './modules/baby-native';
import { MonitorScreen } from './src/screens/MonitorScreen';
import { ParentScreen } from './src/screens/ParentScreen';
import { SetupScreen } from './src/screens/SetupScreen';
import { t } from './src/i18n';
import { loadScreenshotMode } from './src/screenshotMode';
import { loadSecrets, type Secrets } from './src/secrets';
import { SERVICE_TYPE } from './src/session/media';
import { loadSettings, saveSettings, type Settings } from './src/settings';
import { colors } from './src/ui';

// Before any session starts: child effects run before this component's own.
BabyNative.setServiceType(SERVICE_TYPE);

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);

  useEffect(() => {
    Promise.all([loadSettings(), loadScreenshotMode()]).then(([{ settings: loaded, fresh, hadV1Secrets }]) => {
      // The pairing code and keys live in the Keychain. Codes version 1 left in AsyncStorage go.
      // Leftover version 2 items from an earlier installation don't count after a version 1 install.
      const stored = loadSecrets(fresh || hadV1Secrets);
      // A baby unit's id is created once and kept. It isn't secret: it's in every welcome message.
      // Saving at once also marks the installation as no longer fresh (see loadSecrets).
      const next = { ...loaded, monitorId: loaded.monitorId ?? BabyNative.randomDigits(16) };
      if (fresh || !loaded.monitorId || hadV1Secrets) saveSettings(next);
      setSecrets(stored);
      setSettings(next);
    });
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const changeRole = useCallback(() => {
    Alert.alert(t.changeRoleAlert.title, t.changeRoleAlert.body, [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.changeRoleAlert.confirm, style: 'destructive', onPress: () => update({ role: null }) },
    ]);
  }, [update]);

  return (
    <SafeAreaProvider style={{ backgroundColor: colors.background }}>
      {!settings || !secrets ? (
        <View style={{ flex: 1, backgroundColor: colors.background }} />
      ) : settings.role === 'monitor' ? (
        <MonitorScreen settings={settings} credentials={secrets.monitor} onChange={update} onChangeRole={changeRole} />
      ) : settings.role === 'parent' ? (
        <ParentScreen settings={settings} credentials={secrets.parent} onChange={update} onChangeRole={changeRole} />
      ) : (
        <SetupScreen onSelect={(role) => update({ role })} />
      )}
    </SafeAreaProvider>
  );
}
