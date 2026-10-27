/** The web app plays nothing offline, so its heartbeats only wait in memory, for the next try while the page is open. */
let saved: string | null = null;

export const beatStore = {
  read(): string | null {
    return saved;
  },
  write(text: string): void {
    saved = text;
  },
  clear(): void {
    saved = null;
  },
};
