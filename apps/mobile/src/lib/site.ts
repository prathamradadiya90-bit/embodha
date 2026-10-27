import { Linking } from 'react-native';

/**
 * Embodha's public website, where the privacy policy, terms and help live (`apps/site`).
 *
 * Store builds must set EXPO_PUBLIC_SITE_URL. Apple and Google both want the privacy policy reachable from inside the
 * app, and Apple wants the terms and the privacy policy next to every subscription offer. Left unset, as in local
 * development, the links don't show at all, rather than pointing somewhere that isn't there.
 */
export const SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '');

export type SitePage = 'privacy' | 'terms' | 'refunds' | 'support' | 'delete-account';

export const sitePageUrl = (page: SitePage) => `${SITE_URL}/${page}/`;

export const openSitePage = (page: SitePage) => void Linking.openURL(sitePageUrl(page));
