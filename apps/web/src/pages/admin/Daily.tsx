import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Upload } from 'tus-js-client';
import { api, API_URL, authHeader } from '../../lib/api';
import { duration } from '../../lib/format';
import type { MediaStatus, UploadTicket } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

interface DailyItem {
  date: string;
  type: 'quote' | 'image' | 'clip';
  text: string | null;
  author: string | null;
  width: number | null;
  height: number | null;
  media: { id: string; status: MediaStatus; durationS: number | null; preview: string | null } | null;
}
type Quote = DailyItem;

const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const label = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Two weeks ahead: a line, a photo and a short video for each day, all optional. */
export function Daily() {
  const from = todayInIndia();
  const query = useQuery({
    queryKey: ['admin', 'daily', from],
    queryFn: () => api<DailyItem[]>(`/v1/admin/daily?from=${from}`),
    // While Bunny is still making a video's streaming versions, keep asking.
    refetchInterval: (q) => (q.state.data?.some((item) => item.type === 'clip' && item.media?.status !== 'ready' && item.media?.status !== 'failed') ? 5000 : false),
  });
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i));

  return (
    <div className="stack">
      <PageHeader
        title="Today screen"
        lead="A line, a photo and a short video for each day, all optional. Each member sees the ones for their own date, so something set for Friday shows on Friday wherever they are."
      />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorNote error={query.error} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Quote</th>
                <th>Who said it</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {days.map((date) => (
                <DayRow key={date} date={date} quote={query.data.find((q) => q.date === date && q.type === 'quote')} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MediaCard days={days} items={(query.data ?? []).filter((item) => item.type !== 'quote')} />
    </div>
  );
}

/** A photo or a short video for a day, and what's already set. Photos go through the API; videos straight to Bunny. */
function MediaCard({ days, items }: { days: string[]; items: DailyItem[] }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ date: days[0], kind: 'image' as 'image' | 'clip', caption: '', credit: '' });
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const action = useAction();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'daily'] });

  const sendPhoto = async (photo: File) => {
    await api('/v1/me'); // refreshes an expired session before the upload starts
    await new Promise<void>((resolve, reject) => {
      const body = new FormData();
      body.append('file', photo);
      if (form.caption.trim()) body.append('caption', form.caption.trim());
      if (form.credit.trim()) body.append('credit', form.credit.trim());
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/v1/admin/daily/${form.date}/image`);
      Object.entries(authHeader()).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.upload.onprogress = (event) => setProgress(event.loaded / event.total);
      xhr.onload = () => (xhr.status === 201 ? resolve() : reject(new Error(safeMessage(xhr.responseText) ?? `The upload failed (${xhr.status}).`)));
      xhr.onerror = () => reject(new Error('The connection dropped. Try again.'));
      xhr.send(body);
    });
  };

  const sendVideo = async (video: File) => {
    const ticket = await api<UploadTicket>(`/v1/admin/daily/${form.date}/clip`, { method: 'POST', body: { caption: form.caption.trim() || undefined } });
    await new Promise<void>((resolve, reject) => {
      new Upload(video, {
        endpoint: ticket.tus.endpoint,
        headers: Object.fromEntries(Object.entries(ticket.tus.headers).map(([key, value]) => [key, String(value)])),
        metadata: { filetype: video.type, title: `Today ${form.date}` },
        retryDelays: [0, 3000, 10000, 30000],
        onProgress: (sent, total) => setProgress(sent / total),
        onError: (error) => reject(new Error(`The upload stopped (${error.message}). Try again.`)),
        onSuccess: () => resolve(),
      }).start();
    });
  };

  const send = () =>
    void action
      .run(async () => {
        if (!file) return;
        setProgress(0);
        try {
          await (form.kind === 'image' ? sendPhoto(file) : sendVideo(file));
        } finally {
          setProgress(null);
          await refresh();
        }
      })
      .then((ok) => {
        if (!ok) return;
        setFile(null);
        setForm({ ...form, caption: '', credit: '' });
      });

  const remove = (item: DailyItem) =>
    window.confirm(`Take the ${item.type === 'image' ? 'photo' : 'video'} off ${label(item.date)}?`) &&
    void action.run(async () => {
      await api(`/v1/admin/daily/${item.date}/${item.type}`, { method: 'DELETE' });
      await refresh();
    });

  return (
    <Card title="Photo and video of the day">
      <div className="stack">
        <div className="form-grid">
          <Field label="Day">
            <select value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}>
              {days.map((day) => (
                <option key={day} value={day}>
                  {label(day)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What" hint={form.kind === 'image' ? 'JPEG, PNG or WebP, up to 15 MB. We shrink it and remove its location data.' : 'A minute or two is plenty. Members tap to play it.'}>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'image' | 'clip' })}>
              <option value="image">A photo</option>
              <option value="clip">A short video</option>
            </select>
          </Field>
          <Field label="File">
            <input type="file" accept={form.kind === 'image' ? 'image/jpeg,image/png,image/webp' : 'video/*'} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Caption" hint="Optional. One line under it.">
            <input value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} maxLength={140} placeholder="First light over the Western Ghats" />
          </Field>
          {form.kind === 'image' ? (
            <Field label="Photo by" hint="Optional, and kind to include.">
              <input value={form.credit} onChange={(e) => setForm({ ...form, credit: e.target.value })} maxLength={80} />
            </Field>
          ) : null}
        </div>
        <div className="row">
          <Button busy={action.busy} disabled={!file} onClick={send}>
            {items.some((item) => item.date === form.date && item.type === form.kind) ? 'Replace' : 'Upload'}
          </Button>
          {progress !== null ? (
            <span className="progress" style={{ flex: 1 }} aria-label="Upload progress">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          ) : null}
        </div>
        <ErrorNote error={action.error} />
        {items.length ? (
          <div className="daily-media">
            {items.map((item) => (
              <figure key={`${item.date}-${item.type}`} className="daily-thumb">
                {item.media?.preview ? <img src={item.media.preview} alt="" /> : <div className="daily-thumb-empty">{item.type === 'clip' ? 'Video' : 'Photo'}</div>}
                <figcaption>
                  <div>
                    <strong>{label(item.date)}</strong> · {item.type === 'image' ? 'Photo' : `Video${item.media?.durationS ? `, ${duration(item.media.durationS)}` : ''}`}
                    {item.type === 'clip' && item.media?.status !== 'ready' ? (
                      <>
                        {' '}
                        <Badge tone={item.media?.status === 'failed' ? 'red' : 'amber'}>{item.media?.status === 'failed' ? 'Failed' : 'Getting ready'}</Badge>
                      </>
                    ) : null}
                  </div>
                  {item.text ? <div className="small muted">{item.text}</div> : null}
                  <Button variant="quiet" onClick={() => remove(item)}>
                    Remove
                  </Button>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <Empty>No photos or videos set for the next two weeks.</Empty>
        )}
      </div>
    </Card>
  );
}

const safeMessage = (text: string) => {
  try {
    return (JSON.parse(text) as { message?: string }).message;
  } catch {
    return undefined;
  }
};

function DayRow({ date, quote }: { date: string; quote?: Quote }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(quote?.text ?? '');
  const [author, setAuthor] = useState(quote?.author ?? '');
  const action = useAction();
  const changed = text.trim() !== (quote?.text ?? '') || author.trim() !== (quote?.author ?? '');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'daily'] });

  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>{label(date)}</td>
      <td style={{ width: '58%' }}>
        <input aria-label={`Quote for ${label(date)}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={280} placeholder="Nothing set" />
        <ErrorNote error={action.error} />
      </td>
      <td>
        <input aria-label={`Author for ${label(date)}`} value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={80} />
      </td>
      <td>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          {changed && text.trim().length >= 2 ? (
            <Button
              variant="secondary"
              busy={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(`/v1/admin/daily/${date}`, { method: 'PUT', body: { text: text.trim(), author: author.trim() || undefined } });
                  await refresh();
                })
              }
            >
              Save
            </Button>
          ) : null}
          {quote ? (
            <Button
              variant="quiet"
              busy={action.busy}
              onClick={() =>
                void action
                  .run(async () => {
                    await api(`/v1/admin/daily/${date}/quote`, { method: 'DELETE' });
                    await refresh();
                  })
                  .then((ok) => {
                    if (!ok) return;
                    setText('');
                    setAuthor('');
                  })
              }
            >
              Clear
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
