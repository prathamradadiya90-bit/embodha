import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { count, day } from '../../lib/format';
import type { AdminCourse, Audience, Campaign } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader, Toggle } from '../../ui/kit';

const GENDERS: [string, string][] = [
  ['female', 'Women'],
  ['male', 'Men'],
  ['non_binary', 'Non-binary'],
  ['prefer_not_to_say', 'Prefer not to say'],
];

export function describeAudience(audience: Audience | null) {
  if (!audience) return 'Everyone';
  const parts = [
    audience.genders?.length ? audience.genders.map((g) => GENDERS.find(([key]) => key === g)?.[1] ?? g).join(', ') : '',
    audience.ageMin !== undefined || audience.ageMax !== undefined ? `aged ${audience.ageMin ?? 13}–${audience.ageMax ?? '120'}` : '',
    audience.countries?.length ? audience.countries.join(', ') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Everyone';
}

const indianTime = (iso: string | null) =>
  iso ? `${new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} IST` : '';
/** Now, as the time box wants it ("2026-11-02T14:05"), in Indian time. */
const indianNow = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 16);

export function Notifications() {
  const queryClient = useQueryClient();
  const campaigns = useQuery({ queryKey: ['admin', 'campaigns'], queryFn: () => api<Campaign[]>('/v1/admin/notifications') });
  const courses = useQuery({ queryKey: ['admin', 'courses', 'published'], queryFn: () => api<AdminCourse[]>('/v1/admin/courses?status=published') });
  const [form, setForm] = useState({ title: '', body: '', link: '', everyone: true, genders: [] as string[], ageMin: '', ageMax: '', countries: '', later: false, sendAt: '' });
  const action = useAction();

  const audience = useMemo<Audience>(() => {
    if (form.everyone) return {};
    const age = (text: string) => (/^\d{2,3}$/.test(text.trim()) ? Number(text) : undefined);
    const countries = form.countries
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c));
    return {
      ...(form.genders.length ? { genders: form.genders } : {}),
      ...(age(form.ageMin) !== undefined ? { ageMin: age(form.ageMin) } : {}),
      ...(age(form.ageMax) !== undefined ? { ageMax: age(form.ageMax) } : {}),
      ...(countries.length ? { countries } : {}),
    };
  }, [form]);

  // Ask how many people this reaches whenever the audience changes, a moment after the last edit.
  const [audienceKey, setAudienceKey] = useState(JSON.stringify(audience));
  useEffect(() => {
    const timer = setTimeout(() => setAudienceKey(JSON.stringify(audience)), 300);
    return () => clearTimeout(timer);
  }, [audience]);
  const reach = useQuery({
    queryKey: ['admin', 'reach', audienceKey],
    queryFn: () => api<{ members: number; withPush: number }>('/v1/admin/notifications/reach', { method: 'POST', body: { audience: JSON.parse(audienceKey) } }),
  });

  // The time box is Indian time, whatever the computer's clock says.
  const sendAt = form.later && form.sendAt ? new Date(`${form.sendAt}:00+05:30`) : null;
  const ready = form.title.trim().length >= 2 && form.body.trim().length >= 2 && (reach.data?.members ?? 0) > 0 && (!form.later || Boolean(sendAt));
  const send = () => {
    const people = `${count(reach.data?.members ?? 0)} ${reach.data?.members === 1 ? 'member' : 'members'}`;
    const question = sendAt
      ? `Schedule “${form.title.trim()}” for ${indianTime(sendAt.toISOString())}? It goes to whoever matches then (about ${people} today). You can cancel it until it goes.`
      : `Send “${form.title.trim()}” to ${people}? This can't be undone.`;
    if (!window.confirm(question)) return;
    void action
      .run(async () => {
        await api('/v1/admin/notifications', {
          method: 'POST',
          body: { title: form.title.trim(), body: form.body.trim(), deepLink: form.link || undefined, audience, sendAt: sendAt?.toISOString() },
        });
        await queryClient.invalidateQueries({ queryKey: ['admin', 'campaigns'] });
      })
      .then((ok) => ok && setForm({ ...form, title: '', body: '', link: '', later: false, sendAt: '' }));
  };
  const cancel = (campaign: Campaign) => {
    if (!window.confirm(`Cancel “${campaign.title}”? It won't go out.`)) return;
    void action.run(async () => {
      await api(`/v1/admin/notifications/${campaign.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'campaigns'] });
    });
  };
  const set = (key: 'title' | 'body' | 'link' | 'ageMin' | 'ageMax' | 'countries' | 'sendAt') => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  return (
    <div className="stack">
      <PageHeader
        title="Notifications"
        lead="Goes to the bell in everyone's app and, for members who allowed it, to their phone. Phones in their quiet hours (10 pm to 8 am, their time) get the push at 8 am instead. Ages come from the birth year members give at sign-up; anyone who skipped age or gender is left out when you filter on it."
      />
      <Card title="New message">
        <div className="stack">
          <div className="form-grid">
            <Field label="Title" hint={`${form.title.length}/65 · the bold line on the lock screen`}>
              <input value={form.title} onChange={set('title')} maxLength={65} placeholder="A new course for tight hips" />
            </Field>
            <Field label="Open in the app" hint="Where a tap takes them. Leave it on the bell for news.">
              <select value={form.link} onChange={set('link')}>
                <option value="">The bell</option>
                {(courses.data ?? []).map((course) => (
                  <option key={course.id} value={`/course/${course.slug}`}>
                    Course: {course.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Message" hint={`${form.body.length}/240 · phones show about two lines`}>
            <textarea value={form.body} onChange={set('body')} maxLength={240} placeholder="Ten minutes a day, from Asha Rao. The first chapter is free." />
          </Field>
          <Toggle checked={form.everyone} onChange={(everyone) => setForm({ ...form, everyone })} label="Everyone" />
          {!form.everyone ? (
            <div className="stack" style={{ gap: 12 }}>
              <div className="row">
                {GENDERS.map(([key, label]) => (
                  <label key={key} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={form.genders.includes(key)}
                      onChange={(e) => setForm({ ...form, genders: e.target.checked ? [...form.genders, key] : form.genders.filter((g) => g !== key) })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="form-grid">
                <Field label="Age from">
                  <input inputMode="numeric" value={form.ageMin} onChange={set('ageMin')} placeholder="18" />
                </Field>
                <Field label="Age to">
                  <input inputMode="numeric" value={form.ageMax} onChange={set('ageMax')} placeholder="any" />
                </Field>
                <Field label="Countries" hint="Two-letter codes, e.g. IN, AE">
                  <input value={form.countries} onChange={set('countries')} placeholder="all" />
                </Field>
              </div>
            </div>
          ) : null}
          <div className="row">
            <Toggle checked={form.later} onChange={(later) => setForm({ ...form, later })} label="Send later" />
            {form.later ? (
              <input type="datetime-local" aria-label="When to send, Indian time" value={form.sendAt} onChange={set('sendAt')} min={indianNow()} style={{ maxWidth: 240 }} />
            ) : null}
            {form.later ? <span className="small muted">Indian time</span> : null}
          </div>
          <div className="row">
            <Button busy={action.busy} disabled={!ready} onClick={send}>
              {form.later ? 'Schedule' : 'Send now'}
            </Button>
            <span className="small muted">
              {reach.data
                ? `Reaches ${count(reach.data.members)} ${reach.data.members === 1 ? 'member' : 'members'}; ${count(reach.data.withPush)} with notifications on their phone.`
                : 'Counting…'}
            </span>
          </div>
          <ErrorNote error={action.error ?? reach.error} />
        </div>
      </Card>
      <Card title="Scheduled and sent">
        {campaigns.isPending ? (
          <Loading />
        ) : campaigns.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Message</th>
                  <th>To</th>
                  <th>When</th>
                  <th className="num">Members</th>
                  <th className="num">Read</th>
                  <th className="num">Phones</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.title}</strong>
                      <div className="small muted">{c.body}</div>
                    </td>
                    <td className="small">{describeAudience(c.audience)}</td>
                    <td>
                      {c.sentAt ? (
                        <>
                          <span className="muted">{day(c.sentAt)}</span>
                          {c.heldCount ? <div className="small muted">{count(c.heldCount)} waited for 8 am</div> : null}
                        </>
                      ) : (
                        <div className="stack" style={{ gap: 6, alignItems: 'flex-start' }}>
                          <Badge tone="amber">Scheduled</Badge>
                          <span className="small">{indianTime(c.scheduledAt)}</span>
                          <Button variant="quiet" onClick={() => cancel(c)}>
                            Cancel
                          </Button>
                        </div>
                      )}
                    </td>
                    <td className="num">{c.sentAt ? count(c.members) : '—'}</td>
                    <td className="num">{c.sentAt ? count(c.read) : '—'}</td>
                    <td className="num">{c.sentAt ? count(c.sentCount) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing scheduled or sent yet.</Empty>
        )}
        <ErrorNote error={campaigns.error} />
      </Card>
    </div>
  );
}
