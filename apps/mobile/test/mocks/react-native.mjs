export const Platform = { get OS() { return globalThis.__store.os; } };
// The app's foreground and background, driven by the test: state.appListeners get each change.
export const AppState = {
  get currentState() { return globalThis.__store.appStateNow ?? 'active'; },
  addEventListener(_type, listener) {
    const listeners = (globalThis.__store.appListeners ??= []);
    listeners.push(listener);
    return { remove: () => listeners.splice(listeners.indexOf(listener), 1) };
  },
};
