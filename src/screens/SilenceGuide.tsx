import { StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { colors } from '../ui';

// iOS lets no app toggle Do Not Disturb or start Guided Access itself (without device supervision),
// so the baby unit explains the one-time system setup that makes both automatic.
const SECTIONS = [
  { title: t.guide.silenceTitle, steps: t.guide.silenceSteps, result: t.guide.silenceResult },
  { title: t.guide.touchTitle, steps: t.guide.touchSteps, result: t.guide.touchResult },
];

export function SilenceGuide() {
  return (
    <View style={styles.guide}>
      {SECTIONS.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.title}>{section.title}</Text>
          {section.steps.map((step, index) => (
            <View key={step} style={styles.step}>
              <Text style={styles.number}>{index + 1}</Text>
              <Text style={styles.text}>{step}</Text>
            </View>
          ))}
          <Text style={styles.result}>{section.result}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  guide: { gap: 20 },
  section: { gap: 10 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  step: { flexDirection: 'row', gap: 10 },
  number: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 22,
    textAlign: 'center',
  },
  text: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 21 },
  result: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
