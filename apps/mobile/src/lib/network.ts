export interface Connection {
  /** NetInfo's type: wifi, cellular, ethernet, none, unknown… */
  network: string;
  /** On mobile data: 2g, 3g, 4g or 5g, when the phone says. Empty otherwise. */
  generation: string;
}

/**
 * The web app can't tell: a browser's "4g" is a guess at bandwidth, not the network, so it isn't asked. The admin
 * page keeps web starts in a group of their own.
 */
export async function connection(): Promise<Connection> {
  return { network: 'unknown', generation: '' };
}
