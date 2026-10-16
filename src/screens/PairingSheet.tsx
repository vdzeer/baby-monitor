import { useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TextInput, View } from 'react-native';

import { useNow } from '../hooks/useRecent';
import { t } from '../i18n';
import type { ParentState } from '../session/ParentSession';
import { Button, colors } from '../ui';

const CODE_LENGTH = 6;

type Props = {
  pairing: ParentState['pairing'];
  onSubmit: (code: string) => void;
  onCancel: () => void;
};

/** Asks once for the code shown on a new baby unit; it's remembered after that. */
export function PairingSheet({ pairing, onSubmit, onCancel }: Props) {
  const [code, setCode] = useState('');
  const retryAt = pairing?.retryAt ?? null;
  const now = useNow(1_000, retryAt !== null);
  const waitSeconds = retryAt === null ? 0 : Math.ceil((retryAt - now) / 1000);

  const onChangeText = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (digits.length === CODE_LENGTH) {
      setCode('');
      onSubmit(digits);
    } else {
      setCode(digits);
    }
  };

  return (
    <Modal visible={pairing !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={styles.background}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{t.parent.pairTitle}</Text>
          <Text style={styles.body}>{pairing ? t.parent.pairBody(pairing.monitor) : ''}</Text>

          <TextInput
            value={code}
            onChangeText={onChangeText}
            keyboardType="number-pad"
            autoFocus
            maxLength={CODE_LENGTH}
            editable={!pairing?.checking}
            placeholder="000000"
            placeholderTextColor={colors.border}
            style={styles.input}
            accessibilityLabel={t.parent.pairTitle}
          />

          <View style={styles.status}>
            {pairing?.checking ? (
              <>
                <ActivityIndicator color={colors.muted} />
                <Text style={styles.body}>{t.parent.pairChecking}</Text>
              </>
            ) : waitSeconds > 0 || pairing?.wrongCode ? (
              <Text style={styles.error}>
                {waitSeconds > 0
                  ? t.parent.pairTooMany(
                      waitSeconds < 60 ? t.parent.seconds(waitSeconds) : t.parent.minutes(Math.ceil(waitSeconds / 60)),
                    )
                  : t.parent.pairWrong}
              </Text>
            ) : null}
          </View>

          <Button title={t.parent.pairCancel} variant="secondary" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Fills the whole sheet (wider than the content on iPad) so no default white shows at the sides.
  background: { flex: 1, backgroundColor: colors.background },
  sheet: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    gap: 16,
    padding: 24,
    paddingTop: 32,
  },
  title: { color: colors.text, fontSize: 26, fontWeight: '800' },
  body: { color: colors.muted, fontSize: 16, lineHeight: 22 },
  input: {
    color: colors.text,
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: 12,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  status: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  error: { color: colors.danger, fontSize: 16, textAlign: 'center' },
});
