import { useEffect, useMemo, useRef } from 'react';

import BabyNative, { type LiveActivityState } from '../../modules/baby-native';
import { t } from '../i18n';
import { screenshotMode } from '../screenshotMode';
import { SOUND_NAMES } from '../screens/MonitorSettingsForm';
import type { ParentState } from '../session/ParentSession';
import { formatTime } from '../time';
import { useNow } from './useRecent';

/**
 * Mirrors the baby unit's status on the lock screen and in the Dynamic Island. iOS only lets an
 * app start one in the foreground, so it starts once the picture is live and keeps being updated
 * from the background afterwards.
 */
export function useLiveActivity(state: ParentState, enabled: boolean) {
  const { phase, monitor, lastCryAt, lastSoundAt, lastMotionAt, monitorSoundEndsAt, monitorBattery } = state;
  const sound = phase === 'live' ? (state.monitorSettings?.sound ?? 'off') : 'off';
  const now = useNow(60_000, sound !== 'off');

  const content = useMemo((): LiveActivityState => {
    const events = [
      { at: lastCryAt, text: t.parent.crying },
      { at: lastSoundAt, text: t.parent.heard },
      { at: lastMotionAt, text: t.parent.motion },
    ].filter((event): event is { at: number; text: (time: string) => string } => event.at !== null);
    const latest = events.sort((a, b) => b.at - a.at)[0];
    const minutesLeft =
      monitorSoundEndsAt === null ? null : Math.max(1, Math.round((monitorSoundEndsAt - now) / 60_000));
    const battery = monitorBattery && monitorBattery.level >= 0 ? monitorBattery : null;
    return {
      status: phase === 'live' ? 'live' : phase === 'reconnecting' ? 'warning' : 'offline',
      title:
        phase === 'live'
          ? t.parent.live
          : phase === 'reconnecting'
            ? t.parent.connectionLost
            : t.parent.notConnected,
      detail: latest ? latest.text(formatTime(latest.at)) : null,
      sound: sound !== 'off' ? t.parent.playing(SOUND_NAMES[sound], minutesLeft) : null,
      battery: battery ? Math.round(battery.level * 100) : null,
      charging: battery?.charging ?? false,
    };
  }, [phase, lastCryAt, lastSoundAt, lastMotionAt, monitorSoundEndsAt, monitorBattery, sound, now]);

  const started = useRef(false);
  // iOS rations Live Activity updates: send one only when what it shows actually changed.
  const lastSent = useRef('');
  useEffect(() => {
    if (!enabled || screenshotMode) {
      if (started.current) BabyNative.endLiveActivity();
      started.current = false;
      lastSent.current = '';
      return;
    }
    if (!started.current && phase !== 'live') return;
    const name = monitor ?? t.serviceName;
    const serialized = JSON.stringify([name, content]);
    if (serialized === lastSent.current) return;
    started.current = true;
    lastSent.current = serialized;
    BabyNative.updateLiveActivity(name, content);
  }, [enabled, content, phase, monitor]);

  // Leaving the parent screen (another role) ends it.
  useEffect(() => () => BabyNative.endLiveActivity(), []);
}
