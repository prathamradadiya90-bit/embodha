/** Where a crash waits for the next visit in the web app: the browser's local storage, which writes at once. */
const KEY = 'embodha.crash-reports';
const local = () => (globalThis as { localStorage?: Storage }).localStorage;

export const crashStore = {
  read(): string | null {
    return local()?.getItem(KEY) ?? null;
  },
  write(text: string): void {
    local()?.setItem(KEY, text);
  },
  clear(): void {
    local()?.removeItem(KEY);
  },
};
