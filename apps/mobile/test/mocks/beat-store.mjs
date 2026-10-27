// The heartbeats file, as a string the test can read and carry over to the "next launch".
export const beatStore = {
  read: () => globalThis.__store.beatFile ?? null,
  write: (text) => {
    globalThis.__store.beatFile = text;
  },
  clear: () => {
    globalThis.__store.beatFile = null;
  },
};
