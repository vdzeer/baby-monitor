import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { Alert, type GestureResponderEvent, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';

import BabyNative from '../../modules/baby-native';
import { useDimScreen } from '../hooks/useDimScreen';
import { useRecent } from '../hooks/useRecent';
import { useSession } from '../hooks/useSession';
import { t } from '../i18n';
import { MonitorSession } from '../session/MonitorSession';
import type { MonitorCredentials } from '../session/secure/credentials';
import { pickMonitorSettings, type Settings } from '../settings';
import { Button, colors, Message, StatusDot } from '../ui';
import { MonitorSettingsForm } from './MonitorSettingsForm';
import { SilenceGuide } from './SilenceGuide';

// The intro shows the pairing code: keep it up until a parent connects (or at most this long).
const INTRO_MAX_MS = 30_000;
const INTRO_AFTER_PARENT_MS = 3_000;
const MENU_IDLE_MS = 30_000;
// A baby taps and grabs with one hand; holding two fingers still is a deliberate adult gesture.
const UNLOCK_FINGERS = 2;
const UNLOCK_HOLD_MS = 2_000;
// An outdated parent device retries every few seconds; the notice stays while it does.
const OUTDATED_NOTICE_MS = 60_000;

type Props = {
  settings: Settings;
  credentials: MonitorCredentials;
  onChange: (patch: Partial<Settings>) => void;
  onChangeRole: () => void;
};

export function MonitorScreen({ settings, credentials, onChange, onChangeRole }: Props) {
  const [session, state] = useSession(
    () => new MonitorSession(pickMonitorSettings(settings), settings.monitorId ?? '', credentials, onChange),
  );
  // Shown in the intro and as the menu's heading while no parent is watching.
  const outdatedNotice = useRecent(state.outdatedParentAt, OUTDATED_NOTICE_MS)
    ? state.parentNewer
      ? t.monitor.newerParent
      : t.monitor.olderParent
    : null;
  const [intro, setIntro] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuActivity, setMenuActivity] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const unlockTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useKeepAwake();

  useEffect(() => {
    BabyNative.setImmersive(true);
    return () => BabyNative.setImmersive(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setIntro(false), state.viewers > 0 ? INTRO_AFTER_PARENT_MS : INTRO_MAX_MS);
    return () => clearTimeout(timer);
  }, [state.viewers]);

  // Close the menu if nobody touches it for a while, so the room goes dark again
  // (but not while someone is reading the setup guide).
  useEffect(() => {
    if (!menuOpen || guideOpen) return;
    const timer = setTimeout(() => setMenuOpen(false), MENU_IDLE_MS);
    return () => clearTimeout(timer);
  }, [menuOpen, guideOpen, menuActivity]);

  const { error, viewers } = state;
  const monitorSettings = pickMonitorSettings(settings);
  const dark = !intro && !menuOpen && !error;
  useDimScreen(dark);

  // Every touch change reports all fingers currently down; (re)arm only while enough of them rest on the glass.
  const onTouchesChange = (event: GestureResponderEvent) => {
    setIntro(false);
    clearTimeout(unlockTimer.current);
    if (event.nativeEvent.touches.length >= UNLOCK_FINGERS) {
      unlockTimer.current = setTimeout(() => setMenuOpen(true), UNLOCK_HOLD_MS);
    }
  };

  useEffect(() => () => clearTimeout(unlockTimer.current), []);

  const confirmNewCode = () => {
    Alert.alert(t.monitor.newCodeAlertTitle, t.monitor.newCodeAlertBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.monitor.newCode,
        style: 'destructive',
        onPress: () => {
          if (!session.setPairingCode(BabyNative.randomDigits(6))) {
            Alert.alert(t.monitor.newCodeFailedTitle, t.monitor.newCodeFailedBody);
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <StatusBar hidden />

      <View
        style={StyleSheet.absoluteFill}
        onTouchStart={onTouchesChange}
        onTouchEnd={onTouchesChange}
        onTouchCancel={() => clearTimeout(unlockTimer.current)}
      >
        {error ? null : intro && !menuOpen ? (
          <View style={styles.center}>
            <Message
              title={state.stream ? t.monitor.running : t.monitor.startingCamera}
              body={outdatedNotice ? `${t.monitor.introBody}\n\n${outdatedNotice}` : t.monitor.introBody}
            >
              <Text style={styles.code}>{t.monitor.pairingCode(formatCode(state.pairingCode))}</Text>
            </Message>
          </View>
        ) : null}
      </View>

      {error ? (
        <View style={styles.center}>
          <Message
            title={error === 'camera' ? t.monitor.cameraDeniedTitle : t.monitor.networkDeniedTitle}
            body={error === 'camera' ? t.monitor.cameraDeniedBody : t.monitor.networkDeniedBody}
          >
            <Button title={t.common.openSettings} onPress={() => Linking.openSettings()} />
            <Button title={t.common.changeRole} variant="secondary" onPress={onChangeRole} />
          </Message>
        </View>
      ) : null}

      {menuOpen ? (
        <SafeAreaView style={styles.menuBackdrop} onTouchStart={() => setMenuActivity((n) => n + 1)}>
          <ScrollView contentContainerStyle={styles.menuScroll}>
            <View style={styles.menu}>
              <View style={styles.menuHeader}>
                <StatusDot color={viewers > 0 ? colors.live : colors.warning} />
                <Text style={styles.menuTitle}>
                  {viewers > 0 ? t.monitor.watching(viewers) : (outdatedNotice ?? t.monitor.waiting)}
                </Text>
              </View>

              {state.stream ? (
                <RTCView
                  streamURL={state.stream.toURL()}
                  objectFit="cover"
                  mirror={settings.camera === 'front'}
                  style={styles.preview}
                />
              ) : null}

              <MonitorSettingsForm
                settings={monitorSettings}
                onChange={(patch) => session.updateSettings(patch)}
                soundEndsAt={state.soundEndsAt}
              />

              <View style={styles.pairing}>
                <Text style={styles.code}>{t.monitor.pairingCode(formatCode(state.pairingCode))}</Text>
                <Button title={t.monitor.newCode} variant="secondary" onPress={confirmNewCode} />
              </View>

              <Text style={styles.hint}>
                {t.monitor.address(BabyNative.getLocalAddresses().join(', ') || t.monitor.noWifi)}
              </Text>

              <Button
                title={guideOpen ? t.monitor.guideHide : t.monitor.guideShow}
                variant="secondary"
                onPress={() => setGuideOpen((open) => !open)}
              />
              {guideOpen ? <SilenceGuide /> : null}

              <View style={styles.menuActions}>
                <Button
                  title={t.monitor.hideMenu}
                  onPress={() => {
                    setGuideOpen(false);
                    setMenuOpen(false);
                  }}
                />
                <Button title={t.common.changeRole} variant="danger" onPress={onChangeRole} />
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center' },
  menuBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.background },
  menuScroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  menu: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    gap: 18,
    padding: 20,
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
  menuHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  menuTitle: { color: colors.text, fontSize: 18, fontWeight: '700', flexShrink: 1 },
  preview: { height: 220, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.background },
  menuActions: { gap: 10 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  pairing: { gap: 10 },
  code: { color: colors.text, fontSize: 20, fontWeight: '700', textAlign: 'center', fontVariant: ['tabular-nums'] },
});

/** "123456" → "123 456", easier to read across the room. */
function formatCode(code: string) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
