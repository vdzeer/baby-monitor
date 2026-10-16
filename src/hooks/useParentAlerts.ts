import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';

import { t } from '../i18n';
import { notifyInBackground, requestAlertPermission } from '../notifications';
import { screenshotMode } from '../screenshotMode';
import type { ParentState } from '../session/ParentSession';
import type { Settings } from '../settings';

// Short hiccups heal by themselves within seconds; only tell the parent about a real outage.
const LOST_AFTER_MS = 15_000;
const LOW_BATTERY = 0.2;

/** A loud sound and the crying that follows it: one notification, updated, rather than two. */
const NURSERY_SOUND = 'nursery-sound';

/**
 * Notifies the parent about motion, sounds, crying, the baby unit's power, the connection, and a
 * device that paired with the baby unit since this one last saw it.
 */
export function useParentAlerts(
  state: ParentState,
  { motionAlerts, soundAlerts }: Pick<Settings, 'motionAlerts' | 'soundAlerts'>,
) {
  useEffect(() => {
    if (!screenshotMode) requestAlertPermission().catch(() => {});
  }, []);

  useOnChange(state.lastMotionAt, () => {
    if (motionAlerts) notifyInBackground(t.notifications.motionTitle, t.notifications.motionBody);
  });
  useOnChange(state.lastSoundAt, () => {
    if (soundAlerts) notifyInBackground(t.notifications.soundTitle, t.notifications.soundBody, NURSERY_SOUND);
  });
  useOnChange(state.lastCryAt, () => {
    if (soundAlerts) notifyInBackground(t.notifications.cryTitle, t.notifications.cryBody, NURSERY_SOUND);
  });
  // Not an alert setting: someone else can watch the nursery now, the parent must hear about it.
  useOnChange(state.newDeviceAt, () => {
    const { newDeviceTitle, newDeviceBody } = t.notifications;
    if (AppState.currentState === 'active') Alert.alert(newDeviceTitle, newDeviceBody);
    else notifyInBackground(newDeviceTitle, newDeviceBody, 'new-device');
  });

  // The baby unit's power: warn when it's unplugged, and once when its battery runs low.
  const battery = useRef(state.monitorBattery);
  useEffect(() => {
    const previous = battery.current;
    const current = state.monitorBattery;
    battery.current = current;
    if (!previous || !current || current.level < 0) return;
    const percent = Math.round(current.level * 100);
    if (previous.charging && !current.charging) {
      notifyInBackground(t.notifications.unpluggedTitle, t.notifications.unpluggedBody(percent), 'battery');
    } else if (!current.charging && current.level <= LOW_BATTERY && previous.level > LOW_BATTERY) {
      notifyInBackground(t.notifications.lowBatteryTitle(percent), t.notifications.lowBatteryBody, 'battery');
    }
  }, [state.monitorBattery]);

  const lostNotified = useRef(false);
  useEffect(() => {
    if (state.phase === 'reconnecting') {
      const timer = setTimeout(() => {
        lostNotified.current = true;
        notifyInBackground(t.notifications.lostTitle, t.notifications.lostBody, 'connection');
      }, LOST_AFTER_MS);
      return () => clearTimeout(timer);
    }
    if (state.phase === 'live' && lostNotified.current) {
      lostNotified.current = false;
      notifyInBackground(t.notifications.restoredTitle, t.notifications.restoredBody, 'connection');
    }
  }, [state.phase]);
}

/** Runs `effect` when an event timestamp changes, but not for the value it starts with. */
function useOnChange(at: number | null, effect: () => void) {
  const seen = useRef(at);
  const latest = useRef(effect);
  useEffect(() => {
    latest.current = effect;
  });
  useEffect(() => {
    if (at === seen.current) return;
    seen.current = at;
    latest.current();
  }, [at]);
}
