import { File, Paths } from 'expo-file-system';

/**
 * Where a crash waits for the next launch: a small file in the app's cache folder, written synchronously, because
 * the app is about to close when it's written. The cache folder isn't backed up to iCloud or Google.
 */
const file = () => new File(Paths.cache, 'embodha-crash-reports.json');

export const crashStore = {
  read(): string | null {
    const f = file();
    return f.exists ? f.textSync() : null;
  },
  write(text: string): void {
    const f = file();
    if (!f.exists) f.create();
    f.writeSync(text);
  },
  clear(): void {
    const f = file();
    if (f.exists) f.delete();
  },
};
