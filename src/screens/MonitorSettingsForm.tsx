import { StyleSheet, Text, View } from 'react-native';

import { useNow } from '../hooks/useRecent';
import { t } from '../i18n';
import type { MonitorSettings, SleepSound } from '../settings';
import { Chips, colors, Segmented } from '../ui';

export const SOUND_NAMES: Record<Exclude<SleepSound, 'off'>, string> = {
  rainPiano: t.monitor.soundRainPiano,
  lullaby: t.monitor.soundLullaby,
  rain: t.monitor.soundRain,
  ocean: t.monitor.soundOcean,
  noise: t.monitor.soundNoise,
};

const SENSITIVITIES = [
  { value: 'off', title: t.monitor.motionOff },
  { value: 'low', title: t.monitor.motionLow },
  { value: 'medium', title: t.monitor.motionMedium },
  { value: 'high', title: t.monitor.motionHigh },
] as const;

type Props = {
  settings: MonitorSettings;
  onChange: (patch: Partial<MonitorSettings>) => void;
  /** When the sleep sound's timer turns it off (ms since epoch). */
  soundEndsAt: number | null;
};

/** Everything a baby unit can be told to change: shown in its own menu and on parent devices. */
export function MonitorSettingsForm({ settings, onChange, soundEndsAt }: Props) {
  const now = useNow(30_000, soundEndsAt !== null);
  const minutesLeft = soundEndsAt === null ? null : Math.max(1, Math.round((soundEndsAt - now) / 60_000));

  return (
    <View style={styles.form}>
      <Chips
        label={t.monitor.sounds}
        value={settings.sound}
        options={[
          { value: 'off', title: t.monitor.soundOff },
          ...(Object.keys(SOUND_NAMES) as (keyof typeof SOUND_NAMES)[]).map((value) => ({
            value,
            title: SOUND_NAMES[value],
          })),
        ]}
        onChange={(sound) => onChange({ sound })}
      />
      {settings.sound !== 'off' ? (
        <>
          <Segmented
            label={t.monitor.soundVolume}
            value={settings.soundVolume}
            options={[
              { value: 'low', title: t.monitor.volumeLow },
              { value: 'medium', title: t.monitor.volumeMedium },
              { value: 'high', title: t.monitor.volumeHigh },
            ]}
            onChange={(soundVolume) => onChange({ soundVolume })}
          />
          <Segmented
            label={t.monitor.soundTimer}
            value={settings.soundTimer}
            options={[
              { value: '15', title: t.monitor.minutes(15) },
              { value: '30', title: t.monitor.minutes(30) },
              { value: '60', title: t.monitor.minutes(60) },
              { value: 'never', title: t.monitor.timerNever },
            ]}
            onChange={(soundTimer) => onChange({ soundTimer })}
          />
          <Text style={styles.hint}>
            {minutesLeft !== null ? `${t.monitor.soundLeft(minutesLeft)}. ` : ''}
            {t.monitor.soundHint}
          </Text>
        </>
      ) : null}

      <Segmented
        label={t.monitor.camera}
        value={settings.camera}
        options={[
          { value: 'back', title: t.monitor.cameraBack },
          { value: 'front', title: t.monitor.cameraFront },
        ]}
        onChange={(camera) => onChange({ camera })}
      />
      <Segmented
        label={t.monitor.quality}
        value={settings.quality}
        options={[
          { value: '720p', title: '720p' },
          { value: '1080p', title: '1080p' },
        ]}
        onChange={(quality) => onChange({ quality })}
      />
      <Segmented
        label={t.monitor.night}
        value={settings.night}
        options={[
          { value: 'off', title: t.monitor.motionOff },
          { value: 'auto', title: t.monitor.nightAuto },
          { value: 'on', title: t.monitor.nightOn },
        ]}
        onChange={(night) => onChange({ night })}
      />
      <Text style={styles.hint}>{t.monitor.nightHint}</Text>
      <Segmented
        label={t.monitor.motion}
        value={settings.motion}
        options={[...SENSITIVITIES]}
        onChange={(motion) => onChange({ motion })}
      />
      <Segmented
        label={t.monitor.loudness}
        value={settings.loudness}
        options={[...SENSITIVITIES]}
        onChange={(loudness) => onChange({ loudness })}
      />
      <Segmented
        label={t.monitor.cry}
        value={settings.cry}
        options={[
          { value: 'off', title: t.monitor.motionOff },
          { value: 'on', title: t.monitor.nightOn },
        ]}
        onChange={(cry) => onChange({ cry })}
      />
      <Text style={styles.hint}>{t.monitor.cryHint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 18 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
});
