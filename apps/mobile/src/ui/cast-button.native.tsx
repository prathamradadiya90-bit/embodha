import { CastButton as GoogleCastButton } from 'react-native-google-cast';
import { castSupported } from '../lib/cast';

/**
 * Google's own Cast button: it finds the TVs, shows the list, connects, and animates while it does. It hides itself
 * when there's no TV on the Wi-Fi (Android), and on iPhone it waits for the first tap before looking, which is when
 * iOS asks about the local network. On Android, the TV list can only open from this button, so it's always the
 * native one, never a lookalike.
 */
export function CastButton({ color, size = 26 }: { color: string; size?: number }) {
  if (!castSupported) return null;
  return <GoogleCastButton tintColor={color} style={{ width: size, height: size, tintColor: color }} />;
}
