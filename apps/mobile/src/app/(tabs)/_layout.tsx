import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router/js-tabs';
import type { ColorValue } from 'react-native';
import { colors, fonts } from '../../ui/theme';

type IconName = keyof typeof Ionicons.glyphMap;
// The tint colours below are plain hex strings, so the colour handed back is always a string.
const icon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color as string} size={size} />;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: '#8C867F',
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.hairline, borderTopWidth: 1, height: 64, paddingTop: 6 },
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 11, letterSpacing: 0.3 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('sunny-outline') }} />
      <Tabs.Screen name="explore" options={{ title: 'Explore', tabBarIcon: icon('compass-outline') }} />
      <Tabs.Screen name="library" options={{ title: 'Library', tabBarIcon: icon('bookmark-outline') }} />
      <Tabs.Screen name="profile" options={{ title: 'You', tabBarIcon: icon('person-circle-outline') }} />
    </Tabs>
  );
}
