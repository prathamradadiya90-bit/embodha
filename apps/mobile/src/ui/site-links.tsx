import { Fragment } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { openSitePage, SITE_URL, type SitePage } from '../lib/site';
import { colors, fonts, space } from './theme';

const LABELS: Record<SitePage, string> = {
  privacy: 'Privacy policy',
  terms: 'Terms of use',
  refunds: 'Refunds',
  support: 'Help',
  'delete-account': 'Deleting your account',
};

/** A quiet row of links to the website, like "Privacy policy · Terms of use · Help". Nothing at all when the build has no site address. */
export function SiteLinks({ pages, align = 'center', style }: { pages: SitePage[]; align?: 'center' | 'start'; style?: StyleProp<ViewStyle> }) {
  if (!SITE_URL) return null;
  return (
    <View style={[styles.row, align === 'start' && styles.start, style]}>
      {pages.map((page, i) => (
        <Fragment key={page}>
          {i ? (
            <Text style={styles.dot} importantForAccessibility="no" accessibilityElementsHidden>
              ·
            </Text>
          ) : null}
          <Pressable accessibilityRole="link" hitSlop={10} onPress={() => openSitePage(page)} style={({ pressed }) => pressed && styles.pressed}>
            <Text style={styles.link}>{LABELS[page]}</Text>
          </Pressable>
        </Fragment>
      ))}
    </View>
  );
}

/** A link inside a sentence, for "By continuing, you agree to our Terms of use…". */
export const SiteLink = ({ page, children }: { page: SitePage; children: string }) => (
  <Text accessibilityRole="link" onPress={() => openSitePage(page)} style={styles.inline}>
    {children}
  </Text>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', columnGap: space(2), rowGap: space(1) },
  start: { justifyContent: 'flex-start' },
  link: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.ink, textDecorationLine: 'underline' },
  dot: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.inkSoft },
  pressed: { opacity: 0.6 },
  inline: { color: colors.ink, textDecorationLine: 'underline' },
});
