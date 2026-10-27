// The file a crash waits in, kept on the test's state so it carries over to the "next launch".
const m = () => globalThis.__store;
export const crashStore = {
  read() {
    if (m().storageBroken) throw new Error('disk full');
    return m().crashFile ?? null;
  },
  write(text) {
    if (m().storageBroken) throw new Error('disk full');
    m().crashFile = text;
  },
  clear() {
    m().crashFile = null;
  },
};
