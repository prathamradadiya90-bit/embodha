import { Ionicons } from '@expo/vector-icons';
import { router, type ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { reportScreenCrash } from '../lib/crashes';
import { Body, Button, H1 } from './components';
import { colors, space } from './theme';

/**
 * What a screen shows when it fails to draw, instead of a blank page. Each route file exports it, so the rest of the
 * app (tabs, header, the way back) keeps working around it. The failure goes in as a crash report.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    reportScreenCrash(error);
  }, [error]);

  return (
    <View style={styles.page}>
      <Ionicons name="alert-circle-outline" size={40} color={colors.ink} />
      <H1 style={styles.title}>This screen didn't load</H1>
      <Body style={styles.body}>
        Something in the app went wrong here. Trying again usually sorts it out. If it keeps happening, tell us under You, Feedback, and say what you tapped.
      </Body>
      <View style={styles.actions}>
        <Button title="Try again" onPress={() => void retry()} />
        <Button variant="secondary" title="Go to Today" onPress={() => router.replace('/')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', padding: space(6), gap: space(2), backgroundColor: colors.paper },
  title: { marginTop: space(3) },
  body: { color: colors.inkSoft, marginBottom: space(4) },
  actions: { gap: space(3) },
});
