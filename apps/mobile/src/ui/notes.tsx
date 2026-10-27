import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import { clock } from '../lib/format';
import type { Note } from '../lib/types';
import { Body, Button, H2, Muted } from './components';
import { colors, radius, space } from './theme';

/** Private notes under the player, pinned to the moment they were written. Tap a time to jump back to it. */
export function Notes({ chapterId, currentTime, onSeek }: { chapterId: string; currentTime: number; onSeek: (seconds: number) => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['notes', chapterId], queryFn: () => api<Note[]>(`/v1/chapters/${chapterId}/notes`) });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notes', chapterId] });

  const add = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api(`/v1/chapters/${chapterId}/notes`, { method: 'POST', body: { body: text.trim(), timestampS: Math.floor(currentTime) } });
      setText('');
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <H2>Your notes</H2>
      <Muted>Only you can see these.</Muted>
      {query.data?.map((note) => (
        <View key={note.id} style={styles.note}>
          {note.timestampS !== null ? (
            <Pressable onPress={() => onSeek(note.timestampS!)} accessibilityLabel={`Play from ${clock(note.timestampS)}`}>
              <Text style={styles.time}>{clock(note.timestampS)}</Text>
            </Pressable>
          ) : null}
          <Body style={styles.flex}>{note.body}</Body>
          <Pressable
            accessibilityLabel="Delete note"
            hitSlop={8}
            onPress={() => void api(`/v1/notes/${note.id}`, { method: 'DELETE' }).then(refresh).catch(() => setFailed(true))}
          >
            <Ionicons name="trash-outline" size={18} color={colors.inkSoft} />
          </Pressable>
        </View>
      ))}
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={`Add a note at ${clock(currentTime)}`}
        placeholderTextColor={colors.inkSoft}
        multiline
        maxLength={5000}
        style={styles.input}
      />
      {failed ? <Body style={styles.error}>Couldn't save that. Check your connection and try again.</Body> : null}
      <Button variant="secondary" title="Save note" onPress={() => void add()} loading={busy} disabled={!text.trim()} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: space(8), gap: space(2) },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: colors.line },
  time: { color: colors.maroon, fontWeight: '600', fontVariant: ['tabular-nums'], paddingTop: 2 },
  flex: { flex: 1 },
  input: { minHeight: 70, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: space(3), fontSize: 16, color: colors.ink, backgroundColor: colors.surface, textAlignVertical: 'top', marginTop: space(2) },
  error: { color: colors.maroon },
});
