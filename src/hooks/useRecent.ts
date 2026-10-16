import { useEffect, useState } from 'react';

/** True for `ms` after the event at `at` (ms since epoch), then false until the next event. */
export function useRecent(at: number | null, ms: number) {
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setExpired(at), ms);
    return () => clearTimeout(timer);
  }, [at, ms]);
  return at !== null && at !== expired;
}

/** The current time, refreshed every `ms` while `active`. */
export function useNow(ms: number, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, active]);
  return now;
}
