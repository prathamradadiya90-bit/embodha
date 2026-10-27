import { useCallback, useState } from 'react';

/** Runs one button's worth of work, with its own busy flag and error. Resolves true when it worked. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, clear: () => setError(null) };
}
