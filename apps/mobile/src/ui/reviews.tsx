import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ReviewsPage } from '../lib/types';
import { Body, Button, Card, H2, Muted } from './components';
import { colors, radius, space } from './theme';

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

/** Stars and the latest reviews on a course page. Members who've played a chapter can write or edit theirs. */
export function Reviews({ slug }: { slug: string }) {
  const { signedIn } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['reviews', slug, signedIn], queryFn: () => api<ReviewsPage>(`/v1/courses/${slug}/reviews`) });
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!query.data) return null;
  const { average, count, items, mine, canReview } = query.data;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/courses/${slug}/reviews/mine`, { method: 'PUT', body: { rating, body } });
      setEditing(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['reviews', slug] }), queryClient.invalidateQueries({ queryKey: ['course', slug] })]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <H2>Reviews</H2>
      <Muted>{average !== null ? `${stars(Math.round(average))}  ${average.toFixed(1)} from ${count} ${count === 1 ? 'review' : 'reviews'}` : 'No reviews yet.'}</Muted>

      {canReview && !editing ? (
        <View style={styles.gap}>
          <Button
            variant="secondary"
            title={mine ? 'Edit your review' : 'Write a review'}
            onPress={() => {
              setRating(mine?.rating ?? 0);
              setBody(mine?.body ?? '');
              setEditing(true);
            }}
          />
        </View>
      ) : null}
      {mine?.hidden ? <Muted style={styles.gap}>The Embodha team has hidden your review, so only you can see it.</Muted> : null}

      {editing ? (
        <Card style={styles.gap}>
          <View style={styles.picker} accessibilityRole="adjustable" accessibilityLabel={`Rating: ${rating} of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Pressable key={n} onPress={() => setRating(n)} hitSlop={6} accessibilityLabel={`${n} ${n === 1 ? 'star' : 'stars'}`}>
                <Ionicons name={n <= rating ? 'star' : 'star-outline'} size={30} color={colors.maroon} />
              </Pressable>
            ))}
          </View>
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder="What helped? Who would you recommend it to?"
            placeholderTextColor={colors.inkSoft}
            multiline
            maxLength={2000}
            style={styles.input}
          />
          {error ? <Body style={styles.error}>{error}</Body> : null}
          <Button title="Post review" onPress={() => void save()} loading={busy} disabled={!rating} />
          <Button variant="quiet" title="Cancel" onPress={() => setEditing(false)} />
        </Card>
      ) : null}

      {items.slice(0, 5).map((review) => (
        <View key={review.id} style={styles.review}>
          <Text style={styles.stars}>{stars(review.rating)}</Text>
          {review.body ? <Body>{review.body}</Body> : null}
          <Muted>{review.author}</Muted>
          {review.teamReply ? (
            <View style={styles.reply}>
              <Muted>Reply from Embodha</Muted>
              <Body>{review.teamReply}</Body>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: space(10) },
  gap: { marginTop: space(4) },
  picker: { flexDirection: 'row', gap: space(2), marginBottom: space(3) },
  input: { minHeight: 90, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: space(3), fontSize: 16, color: colors.ink, textAlignVertical: 'top', marginBottom: space(3) },
  error: { color: colors.maroon, marginBottom: space(3) },
  review: { paddingVertical: space(4), borderBottomWidth: 1, borderBottomColor: colors.line, gap: space(1) },
  stars: { color: colors.maroon, fontSize: 15, letterSpacing: 1 },
  reply: { marginTop: space(2), paddingLeft: space(3), borderLeftWidth: 2, borderLeftColor: colors.maroonSoft },
});
