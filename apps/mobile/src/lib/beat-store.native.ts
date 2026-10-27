import { File, Paths } from 'expo-file-system';

/**
 * Heartbeats waiting for a connection, as a small file. In the cache folder, so they aren't copied to a new phone
 * by a backup and sent twice.
 */
const file = () => new File(Paths.cache, 'embodha-heartbeats.json');

export const beatStore = {
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
