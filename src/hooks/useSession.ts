import { useEffect, useState, useSyncExternalStore } from 'react';

type Session = {
  start(): unknown;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getState(): object;
};

/** Runs a session while the screen is mounted and re-renders on its state changes. */
export function useSession<S extends Session>(create: () => S): [S, ReturnType<S['getState']>] {
  const [session] = useState(create);

  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);

  const state = useSyncExternalStore(session.subscribe, session.getState);
  return [session, state as ReturnType<S['getState']>];
}
