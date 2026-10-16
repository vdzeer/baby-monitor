import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';

import BabyNative from '../../modules/baby-native';
import { useLiveActivity } from '../hooks/useLiveActivity';
import { useParentAlerts } from '../hooks/useParentAlerts';
import { useNow, useRecent } from '../hooks/useRecent';
import { screenshotMode } from '../screenshotMode';
import { useSession } from '../hooks/useSession';
import { t } from '../i18n';
import { ParentSession, type ParentPhase } from '../session/ParentSession';
import type { ParentCredentials } from '../session/secure/credentials';
import type { Settings } from '../settings';
import { formatTime } from '../time';
import { Button, colors, Message, StatusDot } from '../ui';
import { SOUND_NAMES } from './MonitorSettingsForm';
import { PairingSheet } from './PairingSheet';
import { BatteryBadge, FrameClock, SoundMeter } from './ParentOverlays';
import { ParentSettingsSheet } from './ParentSettingsSheet';

const OVERLAY_MS = 4_000;
const EVENT_BADGE_MS = 60_000;
const MAX_ZOOM = 4;

type Props = {
  settings: Settings;
  credentials: ParentCredentials;
  onChange: (patch: Partial<Settings>) => void;
  onChangeRole: () => void;
};

const PHASE_LABEL: Record<ParentPhase, string> = {
  searching: t.parent.searching,
  choosing: t.parent.choosing,
  connecting: t.parent.connecting,
  live: t.parent.live,
  reconnecting: t.parent.reconnecting,
};

const PHASE_COLOR: Record<ParentPhase, string> = {
  searching: colors.muted,
  choosing: colors.muted,
  connecting: colors.accent,
  live: colors.live,
  reconnecting: colors.warning,
};


export function ParentScreen({ settings, credentials, onChange, onChangeRole }: Props) {
  const [session, state] = useSession(
    () =>
      new ParentSession(
        {
          lastMonitor: settings.lastMonitor,
          monitorAddresses: settings.monitorAddresses,
          pairedDevices: settings.pairedDevices,
        },
        credentials,
        onChange,
      ),
  );
  const [overlay, setOverlay] = useState(true);
  // iOS won't open a Picture in Picture window without a size; use the video's own.
  const [videoSize, setVideoSize] = useState({ width: 1920, height: 1080 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  useKeepAwake();
  useParentAlerts(state, settings);
  const liveActivities = useState(() => BabyNative.areLiveActivitiesEnabled())[0];
  // One or the other when the app goes to the background; iPads have no Live Activities.
  const island = liveActivities && settings.whenMinimized === 'island';
  useLiveActivity(state, island);

  // Enforce the choice on the PiP controller once the video view exists, and again whenever the
  // app is about to leave the screen (just before iOS would decide to start PiP).
  const hasStream = state.stream !== null;
  useEffect(() => {
    if (!hasStream) return;
    const apply = () => BabyNative.setAutoPictureInPicture(!island);
    const timer = setTimeout(apply, 500);
    const subscription = AppState.addEventListener('change', (next) => next !== 'active' && apply());
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [island, hasStream]);

  const phase = state.phase;
  const showMotion = useRecent(state.lastMotionAt, EVENT_BADGE_MS);
  const showSound = useRecent(state.lastSoundAt, EVENT_BADGE_MS);
  const showCry = useRecent(state.lastCryAt, EVENT_BADGE_MS);
  const battery = phase === 'live' && state.monitorBattery && state.monitorBattery.level >= 0 ? state.monitorBattery : null;
  const batteryLow = battery !== null && !battery.charging && battery.level <= 0.2;
  const sleepSound = phase === 'live' ? state.monitorSettings?.sound ?? 'off' : 'off';
  const now = useNow(30_000, sleepSound !== 'off');
  const soundMinutesLeft =
    state.monitorSoundEndsAt === null ? null : Math.max(1, Math.round((state.monitorSoundEndsAt - now) / 60_000));
  // Controls hide themselves a few seconds after the picture is live; problems stay visible.
  const showOverlay =
    overlay || phase !== 'live' || state.videoPaused || showMotion || showSound || showCry || batteryLow;

  useEffect(() => {
    if (!overlay || phase !== 'live' || screenshotMode) return;
    const timer = setTimeout(() => setOverlay(false), OVERLAY_MS);
    return () => clearTimeout(timer);
  }, [overlay, phase]);

  const askAddress = () => {
    Alert.prompt(
      t.parent.connectByIpTitle,
      t.parent.connectByIpBody,
      (host) => {
        const trimmed = host.trim();
        if (trimmed) session.connectAddress(trimmed);
      },
      'plain-text',
      settings.monitorAddresses[0] ?? '',
      'numbers-and-punctuation',
    );
  };

  useEffect(() => {
    if (screenshotMode !== 'settings' || phase !== 'live') return;
    const timer = setTimeout(() => setSettingsOpen(true), 1500);
    return () => clearTimeout(timer);
  }, [phase]);

  const toggleOverlay = () => setOverlay(!showOverlay);

  const togglePictureInPicture = async () => {
    const result = await BabyNative.togglePictureInPicture().catch(() => 'error');
    if (result !== 'started' && result !== 'stopped') {
      // The code in brackets tells us what went wrong if someone reports it.
      Alert.alert(t.parent.pipUnavailableTitle, `${t.parent.pipUnavailableBody} (${result})`);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar hidden={!showOverlay} style="light" />

      {state.stream ? (
        // Native pinch-to-zoom and panning; a tap still toggles the controls.
        <ScrollView
          // A fresh scroll view per screen size, so a rotation starts unzoomed.
          key={`${width}x${height}`}
          style={StyleSheet.absoluteFill}
          // The picture fills whatever the scroll view gets from layout. No `centerContent`: it
          // re-centres only when the frame changes, and a rotation changes the frame before the
          // content, which left the picture off to one side by half the screen difference.
          contentContainerStyle={styles.zoomContent}
          minimumZoomScale={1}
          maximumZoomScale={MAX_ZOOM}
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Pressable style={styles.zoomContent} onPress={toggleOverlay}>
            <RTCView
              streamURL={state.stream.toURL()}
              objectFit="contain"
              style={StyleSheet.absoluteFill}
              iosPIP={
                // Dynamic Island mode: no PiP at all, or iOS would start it when the app goes away.
                island
                  ? { enabled: false }
                  : { enabled: true, startAutomatically: true, stopAutomatically: true, preferredSize: videoSize }
              }
              onDimensionsChange={({ nativeEvent: { width, height } }) => {
                if (width > 0 && height > 0) setVideoSize({ width, height });
              }}
            />
          </Pressable>
        </ScrollView>
      ) : (
        <Pressable style={StyleSheet.absoluteFill} onPress={toggleOverlay} />
      )}

      {!state.stream || phase === 'choosing' ? (
        <View style={[styles.center, state.stream && styles.dimmed]} pointerEvents="box-none">
          {state.localNetworkDenied ? (
            <Message title={t.parent.networkDeniedTitle} body={t.parent.networkDeniedBody}>
              <Button title={t.common.openSettings} onPress={() => Linking.openSettings()} />
            </Message>
          ) : phase === 'choosing' ? (
            <Message title={t.parent.whichMonitor}>
              {state.monitors.map((name) => (
                <Button key={name} title={name} variant="secondary" onPress={() => session.choose(name)} />
              ))}
            </Message>
          ) : (
            <Message
              title={
                state.outdated === 'monitor'
                  ? t.parent.outdatedMonitorTitle
                  : state.outdated === 'parent'
                    ? t.parent.outdatedParentTitle
                    : PHASE_LABEL[phase]
              }
              body={
                state.outdated === 'monitor'
                  ? t.parent.outdatedMonitorBody
                  : state.outdated === 'parent'
                    ? t.parent.outdatedParentBody
                    : phase === 'searching'
                      ? t.parent.searchingBody
                      : undefined
              }
            >
              <ActivityIndicator color={colors.muted} />
            </Message>
          )}
        </View>
      ) : null}

      {showOverlay ? (
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <View style={styles.pills} pointerEvents="none">
            <View style={styles.pill}>
              <StatusDot color={PHASE_COLOR[phase]} />
              <Text style={styles.pillText} numberOfLines={1}>
                {phase === 'live' && state.monitor ? `${PHASE_LABEL.live} · ${state.monitor}` : PHASE_LABEL[phase]}
              </Text>
            </View>
            {state.videoPaused && phase === 'live' ? (
              <View style={styles.pill}>
                <StatusDot color={colors.warning} />
                <Text style={styles.pillText} numberOfLines={1}>
                  {t.parent.audioOnly}
                </Text>
              </View>
            ) : null}
            {battery ? (
              <View style={styles.pill}>
                <BatteryBadge battery={battery} />
              </View>
            ) : null}
            {showCry && state.lastCryAt !== null ? (
              <View style={styles.pill}>
                <StatusDot color={colors.danger} />
                <Text style={styles.pillText} numberOfLines={1}>
                  {t.parent.crying(formatTime(state.lastCryAt))}
                </Text>
              </View>
            ) : null}
            {showSound && state.lastSoundAt !== null ? (
              <View style={styles.pill}>
                <StatusDot color={colors.danger} />
                <Text style={styles.pillText} numberOfLines={1}>
                  {t.parent.heard(formatTime(state.lastSoundAt))}
                </Text>
              </View>
            ) : null}
            {sleepSound !== 'off' ? (
              <View style={styles.pill}>
                <Text style={styles.pillText} numberOfLines={1}>
                  {t.parent.playing(SOUND_NAMES[sleepSound], soundMinutesLeft)}
                </Text>
              </View>
            ) : null}
            {showMotion && state.lastMotionAt !== null ? (
              <View style={styles.pill}>
                <StatusDot color={colors.danger} />
                <Text style={styles.pillText} numberOfLines={1}>
                  {t.parent.motion(formatTime(state.lastMotionAt))}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.buttons}>
            {state.stream && !island ? (
              <Pressable
                onPress={togglePictureInPicture}
                hitSlop={12}
                style={styles.roundButton}
                accessibilityRole="button"
                accessibilityLabel={t.parent.pictureInPicture}
              >
                <View style={styles.pipIcon}>
                  <View style={styles.pipIconInner} />
                </View>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => setSettingsOpen(true)}
              hitSlop={12}
              style={styles.roundButton}
              accessibilityRole="button"
              accessibilityLabel={t.parent.settings}
            >
              <Text style={styles.menuButtonText}>•••</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {state.stream ? (
        // Always on screen: when the picture was last updated, and how loud the room is.
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]} pointerEvents="none">
          {state.lastFrameAt !== null ? <FrameClock lastFrameAt={state.lastFrameAt} /> : <View />}
          {phase === 'live' ? <SoundMeter /> : null}
        </View>
      ) : null}

      <PairingSheet
        pairing={state.pairing}
        onSubmit={(code) => session.submitPairingCode(code)}
        onCancel={() => session.cancelPairing()}
      />

      <ParentSettingsSheet
        visible={settingsOpen && state.pairing === null}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={onChange}
        liveActivities={liveActivities}
        monitorSettings={phase === 'live' ? state.monitorSettings : null}
        devices={phase === 'live' ? state.monitorDevices : null}
        soundEndsAt={state.monitorSoundEndsAt}
        onMonitorChange={(patch) => session.updateMonitorSettings(patch)}
        otherMonitors={state.monitors.filter((name) => name !== state.monitor)}
        onWatch={(name) => session.choose(name)}
        onConnectByIp={askAddress}
        onChangeRole={onChangeRole}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  zoomContent: { flexGrow: 1 },
  center: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'center' },
  dimmed: { backgroundColor: 'rgba(0, 0, 0, 0.75)' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
  },
  pills: { flexShrink: 1, alignItems: 'flex-start', gap: 8 },
  bottomBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  pill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  pillText: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  buttons: { flexDirection: 'row', gap: 10 },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  menuButtonText: { color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: 1 },
  // A small "window inside a window" glyph for Picture in Picture.
  pipIcon: {
    width: 20,
    height: 15,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: colors.text,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    padding: 2,
  },
  pipIconInner: { width: 8, height: 6, borderRadius: 1, backgroundColor: colors.text },
});
