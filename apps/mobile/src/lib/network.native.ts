import NetInfo, { NetInfoStateType } from '@react-native-community/netinfo';
import type { Connection } from './network';

// NetInfo's usual "is the internet really there" check pings a Google address. Embodha only needs to know the kind
// of connection, which the phone already knows, so that check is off.
NetInfo.configure({ reachabilityShouldRun: () => false, shouldFetchWiFiSSID: false });

/** Wi-Fi or mobile data, and on mobile data, 4G or 5G and so on. For timing how long chapters take to start. */
export async function connection(): Promise<Connection> {
  try {
    const state = await NetInfo.fetch();
    const generation = state.type === NetInfoStateType.cellular ? (state.details.cellularGeneration ?? '') : '';
    return { network: state.type, generation };
  } catch {
    return { network: 'unknown', generation: '' };
  }
}
