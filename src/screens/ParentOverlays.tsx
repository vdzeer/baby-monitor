import { useEventListener } from 'expo';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import BabyNative, { type Battery } from '../../modules/baby-native';
import { useNow } from '../hooks/useRecent';
import { t } from '../i18n';
import { screenshotMode } from '../screenshotMode';
import { formatTime } from '../time';
import { colors } from '../ui';

// A picture older than this is called out: frames normally arrive many times a second.
const STALE_MS = 3_000;

/** When the picture on screen was last updated, like a security camera's timestamp. */
export function FrameClock({ lastFrameAt }: { lastFrameAt: number }) {
  const now = useNow(1000, true);
  const staleSeconds = Math.floor((now - lastFrameAt) / 1000);
  const stale = now - lastFrameAt > STALE_MS;
  return (
    <View style={[styles.badge, stale && styles.badgeWarning]}>
      <Text style={[styles.clock, stale && styles.clockWarning]}>
        {formatTime(lastFrameAt, true)}
        {stale ? ` · ${t.parent.secondsAgo(staleSeconds)}` : ''}
      </Text>
    </View>
  );
}

const METER_STEPS = 5;
const METER_COLORS = [colors.live, colors.live, colors.live, colors.warning, colors.danger];

/** How loud the nursery is right now, like the lights on a classic baby monitor. */
export function SoundMeter() {
  // Screenshots: a simulator plays no sound, so show a softly humming nursery instead.
  const [level, setLevel] = useState(screenshotMode ? 0.5 : 0);
  // Rise at once, fall back gently, so short sounds stay visible for a moment.
  useEventListener(BabyNative, 'onPlayoutLevel', ({ level: next }) => {
    if (!screenshotMode) setLevel((current) => Math.max(next, current * 0.6));
  });
  const lit = Math.round(level * METER_STEPS);
  return (
    <View style={[styles.badge, styles.meter]}>
      {METER_COLORS.map((color, index) => (
        <View
          key={index}
          style={[styles.bar, { height: 8 + index * 4, backgroundColor: index < lit ? color : colors.border }]}
        />
      ))}
    </View>
  );
}

/** The baby unit's battery as a small gauge, e.g. "▮▮▯ 78%" or "⚡ 100%". */
export function BatteryBadge({ battery }: { battery: Battery }) {
  const percent = Math.round(battery.level * 100);
  const low = !battery.charging && battery.level <= 0.2;
  const tint = low ? colors.warning : colors.text;
  return (
    <View style={styles.battery}>
      <View style={[styles.batteryBody, { borderColor: tint }]}>
        <View style={[styles.batteryFill, { width: `${Math.max(8, percent)}%`, backgroundColor: low ? colors.warning : colors.live }]} />
      </View>
      <View style={[styles.batteryTip, { backgroundColor: tint }]} />
      <Text style={[styles.batteryText, { color: tint }]}>
        {battery.charging ? '⚡ ' : ''}
        {percent}%
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  badgeWarning: { backgroundColor: 'rgba(60, 36, 0, 0.8)' },
  clock: { color: colors.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  clockWarning: { color: colors.warning },
  meter: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingVertical: 9 },
  bar: { width: 6, borderRadius: 2 },
  battery: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  batteryBody: { width: 24, height: 12, borderRadius: 3, borderWidth: 1.5, padding: 1.5 },
  batteryFill: { height: '100%', borderRadius: 1 },
  batteryTip: { width: 2, height: 5, borderRadius: 1 },
  batteryText: { fontSize: 15, fontWeight: '600', marginLeft: 6, fontVariant: ['tabular-nums'] },
});
