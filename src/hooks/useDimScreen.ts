import * as Brightness from 'expo-brightness';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Turns the screen brightness to zero while `active` and the app is in the foreground,
 * and puts the previous level back otherwise. iOS itself resets it when the device locks.
 */
export function useDimScreen(active: boolean) {
  const original = useRef<number | null>(null);
  // Brightness calls are async; run them in order so a restore never reads an already-dimmed value.
  const chain = useRef(Promise.resolve());

  useEffect(() => {
    const apply = (dim: boolean) => {
      chain.current = chain.current
        .then(async () => {
          if (dim) {
            if (original.current === null) original.current = await Brightness.getBrightnessAsync();
            await Brightness.setBrightnessAsync(0);
          } else if (original.current !== null) {
            const level = original.current;
            original.current = null;
            await Brightness.setBrightnessAsync(level);
          }
        })
        .catch(() => {});
    };

    apply(active && AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (state) => apply(active && state === 'active'));
    return () => {
      subscription.remove();
      apply(false);
    };
  }, [active]);
}
