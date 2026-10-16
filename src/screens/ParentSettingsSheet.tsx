import { Modal, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { t } from '../i18n';
import type { MonitorSettings, Settings } from '../settings';
import { Button, colors, Segmented } from '../ui';
import { MonitorSettingsForm } from './MonitorSettingsForm';

type Props = {
  visible: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** This device shows Live Activities, so the Dynamic Island is a choice. */
  liveActivities: boolean;
  /** The connected baby unit's settings; null while not connected. */
  monitorSettings: MonitorSettings | null;
  /** Parent devices paired with the connected baby unit and watching now; null while not connected. */
  devices: { paired: number; watching: number } | null;
  onMonitorChange: (patch: Partial<MonitorSettings>) => void;
  soundEndsAt: number | null;
  otherMonitors: string[];
  onWatch: (name: string) => void;
  onConnectByIp: () => void;
  onChangeRole: () => void;
};

export function ParentSettingsSheet({
  visible,
  onClose,
  settings,
  onChange,
  liveActivities,
  monitorSettings,
  devices,
  onMonitorChange,
  soundEndsAt,
  otherMonitors,
  onWatch,
  onConnectByIp,
  onChangeRole,
}: Props) {
  // Who else can watch: shown with the baby unit's settings, so an unknown device stands out.
  const monitorHint = !monitorSettings
    ? t.parent.monitorOffline
    : devices
      ? `${t.parent.devices(devices.paired, devices.watching)} ${t.parent.devicesHint}`
      : null;

  // Actions that open another dialog close the sheet first: iOS shows only one at a time.
  const closeThen = (action: () => void) => () => {
    onClose();
    setTimeout(action, 400);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>{t.parent.settings}</Text>
          <Text style={styles.done} onPress={onClose} accessibilityRole="button">
            {t.parent.done}
          </Text>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.section}>{t.parent.monitorSection}</Text>
          {monitorSettings && (
            <View style={styles.card}>
              <MonitorSettingsForm settings={monitorSettings} onChange={onMonitorChange} soundEndsAt={soundEndsAt} />
            </View>
          )}
          {monitorHint && <Text style={styles.hint}>{monitorHint}</Text>}

          <Text style={styles.section}>{t.parent.deviceSection}</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.rowTitle}>{t.parent.motionAlerts}</Text>
              <Switch
                value={settings.motionAlerts}
                onValueChange={(motionAlerts) => onChange({ motionAlerts })}
                trackColor={{ true: colors.accent }}
              />
            </View>
            <View style={styles.row}>
              <Text style={styles.rowTitle}>{t.parent.soundAlerts}</Text>
              <Switch
                value={settings.soundAlerts}
                onValueChange={(soundAlerts) => onChange({ soundAlerts })}
                trackColor={{ true: colors.accent }}
              />
            </View>
            <Text style={styles.hint}>{t.parent.motionAlertsHint}</Text>
          </View>

          {liveActivities ? (
            <View style={styles.card}>
              <Segmented
                label={t.parent.whenMinimized}
                value={settings.whenMinimized}
                options={[
                  { value: 'pip', title: t.parent.minimizedPip },
                  { value: 'island', title: t.parent.minimizedIsland },
                ]}
                onChange={(whenMinimized) => onChange({ whenMinimized })}
              />
              <Text style={styles.hint}>
                {settings.whenMinimized === 'pip' ? t.parent.pipHint : t.parent.islandHint}
              </Text>
            </View>
          ) : null}

          {otherMonitors.length > 0 ? (
            <>
              <Text style={styles.section}>{t.parent.otherMonitors}</Text>
              <View style={styles.card}>
                {otherMonitors.map((name) => (
                  <Button key={name} title={t.parent.watch(name)} variant="secondary" onPress={closeThen(() => onWatch(name))} />
                ))}
              </View>
            </>
          ) : null}

          <View style={styles.actions}>
            <Button title={t.parent.connectByIp} variant="secondary" onPress={closeThen(onConnectByIp)} />
            <Button title={t.common.changeRole} variant="danger" onPress={closeThen(onChangeRole)} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  done: { color: colors.accent, fontSize: 17, fontWeight: '600', padding: 8 },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', padding: 20, gap: 10 },
  section: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: 14,
  },
  card: { gap: 18, padding: 16, borderRadius: 18, backgroundColor: colors.surface },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowTitle: { color: colors.text, fontSize: 17, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 14, lineHeight: 19 },
  actions: { gap: 10, marginTop: 24 },
});
