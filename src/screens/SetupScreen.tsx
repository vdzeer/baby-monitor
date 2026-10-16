import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { t } from '../i18n';
import type { Role } from '../settings';
import { colors } from '../ui';

const ROLES: { role: Role; emoji: string; title: string; body: string }[] = [
  { role: 'monitor', emoji: '👶', title: t.setup.monitorTitle, body: t.setup.monitorBody },
  { role: 'parent', emoji: '👀', title: t.setup.parentTitle, body: t.setup.parentBody },
];

export function SetupScreen({ onSelect }: { onSelect: (role: Role) => void }) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>{t.setup.title}</Text>
        <Text style={styles.subtitle}>{t.setup.subtitle}</Text>

        <View style={styles.cards}>
          {ROLES.map(({ role, emoji, title, body }) => (
            <Pressable
              key={role}
              onPress={() => onSelect(role)}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            >
              <Text style={styles.emoji}>{emoji}</Text>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>{title}</Text>
                <Text style={styles.cardBody}>{body}</Text>
              </View>
            </Pressable>
          ))}
        </View>

        <Text style={styles.footnote}>{t.setup.footnote}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  title: { color: colors.text, fontSize: 34, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 18, marginTop: 6 },
  cards: { gap: 14, marginTop: 32 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 20,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardPressed: { opacity: 0.75 },
  emoji: { fontSize: 40 },
  cardText: { flex: 1, gap: 4 },
  cardTitle: { color: colors.text, fontSize: 21, fontWeight: '700' },
  cardBody: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  footnote: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 28 },
});
