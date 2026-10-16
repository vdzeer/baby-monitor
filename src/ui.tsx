import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export const colors = {
  background: '#000000',
  surface: '#17171C',
  surfaceRaised: '#23232B',
  border: '#2E2E38',
  text: '#F2F2F5',
  muted: '#8E8E9A',
  accent: '#8FA8FF',
  live: '#3DDC84',
  warning: '#FFB547',
  danger: '#FF7A7A',
};

export function Button({
  title,
  onPress,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          variant === 'primary' && styles.buttonTextPrimary,
          variant === 'danger' && styles.buttonTextDanger,
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; title: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmentedRow}>
      <Text style={styles.segmentedLabel}>{label}</Text>
      <View style={styles.segmented}>
        {options.map((option) => (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segment, option.value === value && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, option.value === value && styles.segmentTextActive]}>
              {option.title}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** Like Segmented, for more options than fit on one line: they wrap. */
export function Chips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; title: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmentedRow}>
      <Text style={styles.segmentedLabel}>{label}</Text>
      <View style={styles.chips}>
        {options.map((option) => (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.chip, option.value === value && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: option.value === value }}
          >
            <Text style={[styles.segmentText, option.value === value && styles.chipTextActive]}>{option.title}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function StatusDot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

export function Message({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageTitle}>{title}</Text>
      {body ? <Text style={styles.messageBody}>{body}</Text> : null}
      {children ? <View style={styles.messageActions}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    borderRadius: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  pressed: { opacity: 0.7 },
  buttonText: { color: colors.text, fontSize: 17, fontWeight: '600' },
  buttonTextPrimary: { color: '#0B0B10' },
  buttonTextDanger: { color: colors.danger },
  segmentedRow: { gap: 8 },
  segmentedLabel: { color: colors.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: 12,
    padding: 3,
  },
  segment: { flex: 1, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segmentActive: { backgroundColor: colors.border },
  segmentText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  segmentTextActive: { color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  chipActive: { backgroundColor: colors.accent },
  chipTextActive: { color: '#0B0B10' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  message: { maxWidth: 420, alignSelf: 'center', alignItems: 'center', gap: 10, paddingHorizontal: 24 },
  messageTitle: { color: colors.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  messageBody: { color: colors.muted, fontSize: 16, lineHeight: 22, textAlign: 'center' },
  messageActions: { alignSelf: 'stretch', gap: 10, marginTop: 14 },
});
