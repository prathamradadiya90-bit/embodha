import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { deviceRegion } from '../lib/format';
import { matchStates, stateName } from '../lib/india';
import { syncPushToken } from '../lib/push';
import { Body, Button, Chip, H1, Muted, Screen, Section } from '../ui/components';
import { colors, radius, space } from '../ui/theme';

export { ErrorBoundary } from '../ui/error-boundary';

const COUNTRIES: [string, string][] = [
  ['IN', 'India'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['AE', 'UAE'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['SG', 'Singapore'],
];

const GENDERS: [string, string][] = [
  ['female', 'Woman'],
  ['male', 'Man'],
  ['non_binary', 'Non-binary'],
  ['prefer_not_to_say', 'Prefer not to say'],
];

const GOALS: [string, string][] = [
  ['sleep', 'Sleep better'],
  ['stress', 'Less stress'],
  ['fitness', 'Fitness'],
  ['flexibility', 'Flexibility'],
  ['focus', 'Focus'],
  ['strength', 'Strength'],
  ['healing', 'Healing'],
];

/**
 * The details asked for after sign-up, and again from You to change them. Country sets prices and GST, the state
 * (in India) decides CGST and SGST or IGST on website invoices, and year of birth covers the 18+ rule.
 */
export default function Onboarding() {
  const { me, updateMe } = useAuth();
  const editing = useLocalSearchParams<{ edit?: string }>().edit === '1';
  const region = deviceRegion();
  const [name, setName] = useState(me?.name ?? '');
  const [country, setCountry] = useState(me?.country ?? (region && COUNTRIES.some(([code]) => code === region) ? region : 'IN'));
  const [otherCountry, setOtherCountry] = useState('');
  const [birthYear, setBirthYear] = useState(me?.birthYear ? String(me.birthYear) : '');
  const [goals, setGoals] = useState<string[]>(me?.preferences.goals ?? []);
  const [gender, setGender] = useState<string | null>(me?.gender ?? null);
  const [state, setState] = useState<string | null>(me?.state ?? null);
  const [stateQuery, setStateQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usingOther = country === 'OTHER';
  const chosenCountry = usingOther ? otherCountry.trim().toUpperCase() : country;
  const inIndia = chosenCountry === 'IN';
  const ready = name.trim().length > 0 && /^\d{4}$/.test(birthYear) && /^[A-Z]{2}$/.test(chosenCountry) && (!inIndia || Boolean(state));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateMe({ name: name.trim(), country: chosenCountry, state: inIndia ? state : null, birthYear: Number(birthYear), goals, ...(gender ? { gender } : {}) });
      if (editing) return router.back();
      router.replace('/');
      // Right after they've told us about themselves is a fair moment to ask about notifications.
      void syncPushToken(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['bottom']}>
      <H1>{editing ? 'Your details' : 'A little about you'}</H1>
      <Body style={styles.lead}>{editing ? 'Where you live sets your prices, and the tax on your invoices.' : 'This sets your prices and reminders. You can change it later, under You.'}</Body>

      <Muted>Your name</Muted>
      <TextInput value={name} onChangeText={setName} placeholder="First name is fine" placeholderTextColor={colors.inkSoft} style={styles.input} autoComplete="name" />

      <Muted>Where you live</Muted>
      <View style={styles.chips}>
        {COUNTRIES.map(([code, label]) => (
          <Chip key={code} label={label} selected={country === code} onPress={() => setCountry(code)} />
        ))}
        <Chip label="Somewhere else" selected={usingOther} onPress={() => setCountry('OTHER')} />
      </View>
      {usingOther ? (
        <TextInput
          value={otherCountry}
          onChangeText={setOtherCountry}
          placeholder="Two-letter country code, e.g. DE"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="characters"
          maxLength={2}
          style={styles.input}
        />
      ) : null}

      {inIndia ? (
        <>
          <Muted>Your state</Muted>
          {state ? (
            <View style={styles.chips}>
              <Chip label={stateName(state) ?? state} selected onPress={() => setState(null)} />
              <Muted style={styles.inline}>Tap to change</Muted>
            </View>
          ) : (
            <>
              <TextInput
                value={stateQuery}
                onChangeText={setStateQuery}
                placeholder="Start typing, e.g. Kerala"
                placeholderTextColor={colors.inkSoft}
                autoCorrect={false}
                style={[styles.input, styles.find]}
              />
              <View style={styles.chips}>
                {matchStates(stateQuery).map(([code, label]) => (
                  <Chip
                    key={code}
                    label={label}
                    onPress={() => {
                      setState(code);
                      setStateQuery('');
                    }}
                  />
                ))}
              </View>
            </>
          )}
        </>
      ) : null}

      <Muted>Year you were born</Muted>
      <TextInput
        value={birthYear}
        onChangeText={(value) => setBirthYear(value.replace(/\D/g, '').slice(0, 4))}
        placeholder="1990"
        placeholderTextColor={colors.inkSoft}
        keyboardType="number-pad"
        style={styles.input}
      />

      <Muted>Gender (optional)</Muted>
      <View style={styles.chips}>
        {GENDERS.map(([key, label]) => (
          <Chip key={key} label={label} selected={gender === key} onPress={() => setGender(gender === key ? null : key)} />
        ))}
      </View>

      <Section title="What brings you here?">
        <View style={styles.chips}>
          {GOALS.map(([key, label]) => (
            <Chip
              key={key}
              label={label}
              selected={goals.includes(key)}
              onPress={() => setGoals((current) => (current.includes(key) ? current.filter((g) => g !== key) : [...current, key]))}
            />
          ))}
        </View>
      </Section>

      {error ? <Body style={styles.error}>{error}</Body> : null}
      <View style={styles.save}>
        <Button title={editing ? 'Save' : 'Save and continue'} onPress={() => void save()} loading={busy} disabled={!ready} />
        {editing ? <Button variant="quiet" title="Cancel" onPress={() => router.back()} /> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { marginBottom: space(6), color: colors.inkSoft },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: space(4), paddingVertical: space(3), fontSize: 17, color: colors.ink, marginTop: space(2), marginBottom: space(5) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2), marginBottom: space(5) },
  error: { color: colors.maroon, marginTop: space(4) },
  save: { marginTop: space(6), gap: space(2) },
  find: { marginBottom: space(1) },
  inline: { alignSelf: 'center' },
});
