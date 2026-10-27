import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api';
import { day } from '../../lib/format';
import type { StudioChapter, StudioCourse, StudioOptions } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, CourseStatusBadge, Empty, ErrorNote, Field, Loading, PageHeader, Toggle } from '../../ui/kit';
import { ChapterUpload } from './ChapterUpload';

export function CourseEditor() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const course = useQuery({ queryKey: ['studio', 'course', id], queryFn: () => api<StudioCourse>(`/v1/studio/courses/${id}`) });
  const options = useQuery({ queryKey: ['studio', 'options'], queryFn: () => api<StudioOptions>('/v1/studio/options') });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['studio', 'course', id] });
    void queryClient.invalidateQueries({ queryKey: ['studio', 'courses'] });
  }, [queryClient, id]);

  if (course.isPending || options.isPending) return <Loading />;
  if (course.isError || options.isError) return <ErrorNote error={course.error ?? options.error} />;
  const c = course.data;
  const draft = c.status === 'draft';
  const live = c.status === 'published';
  // A live course is edited as a copy; while the copy is with admin, nothing changes.
  const editing = draft || (live && c.changes?.state !== 'in_review');
  const topic = options.data.topics.find((t) => t.id === c.topicId);

  return (
    <div className="stack">
      <p className="small">
        <Link to="/studio">← Your courses</Link>
      </p>
      <PageHeader
        title={c.title}
        lead={
          <>
            <CourseStatusBadge status={c.status} /> {topic ? `${topic.category} · ${topic.name}` : ''}
          </>
        }
        actions={draft ? <Submit course={c} onDone={refresh} /> : live ? <ChangeActions course={c} onDone={refresh} /> : null}
      />
      <StatusNote course={c} />
      <Details key={`${c.id}-${c.status}-${c.changes?.state}`} course={c} options={options.data} editable={editing} priceLocked={live} onSaved={refresh} />
      <Chapters course={c} editable={editing} onChange={refresh} />
    </div>
  );
}

function StatusNote({ course }: { course: StudioCourse }) {
  const review = course.review;
  if (course.status === 'in_review') {
    return <p className="notice">With the Embodha team since {day(review?.submittedAt)}. If they send it back, you can edit it again.</p>;
  }
  if (course.status === 'draft' && review?.decision === 'rejected') {
    return (
      <p className="notice red">
        Sent back with this note: “{review.comments}” Make the changes, then send it for review again.
      </p>
    );
  }
  if (course.status === 'published') {
    const changes = course.changes;
    const last = changes?.lastDecision;
    if (changes?.state === 'in_review') {
      return <p className="notice">Your changes are with the Embodha team since {day(changes.submittedAt)}. Members see the course as it was until they're approved.</p>;
    }
    if (changes?.state === 'editing') {
      return (
        <p className={`notice${last?.decision === 'rejected' ? ' red' : ''}`}>
          {last?.decision === 'rejected' ? `Sent back with this note: “${last.comments}” ` : ''}
          You're changing a live course. Members still see it as it was; send your changes for review when you're done.
        </p>
      );
    }
    return (
      <p className="notice green">
        Live in the app.{last?.decision === 'approved' ? ` Your last changes went live on ${day(last.reviewedAt)}.` : ''} You can edit it below: changes stay with you
        until the Embodha team approves them, so members never see a half-finished course.
      </p>
    );
  }
  if (course.status === 'archived') return <p className="notice">Archived. Members can't find it in the app.</p>;
  return null;
}

/** For a live course: send the changes to admin, take them back, or throw them away. */
function ChangeActions({ course, onDone }: { course: StudioCourse; onDone: () => void }) {
  const action = useAction();
  const state = course.changes?.state;
  const missing = action.error instanceof ApiError && Array.isArray(action.error.body.chapters) ? (action.error.body.chapters as string[]) : [];
  const go = (path: string, method = 'POST') => void action.run(() => api(`/v1/studio/courses/${course.id}/changes${path}`, { method })).then((ok) => ok && onDone());
  if (!state) return null;
  return (
    <div className="stack" style={{ gap: 6, alignItems: 'flex-end' }}>
      <div className="row">
        {state === 'editing' ? (
          <>
            <Button variant="quiet" busy={action.busy} onClick={() => window.confirm('Throw your changes away? The live course stays as it is.') && go('', 'DELETE')}>
              Discard changes
            </Button>
            <Button busy={action.busy} onClick={() => go('/submit')}>
              Send changes for review
            </Button>
          </>
        ) : (
          <Button variant="secondary" busy={action.busy} onClick={() => go('/withdraw')}>
            Take back to edit
          </Button>
        )}
      </div>
      <ErrorNote error={action.error} />
      {missing.length ? <span className="small muted">Waiting on: {missing.join(', ')}</span> : null}
    </div>
  );
}

function Submit({ course, onDone }: { course: StudioCourse; onDone: () => void }) {
  const action = useAction();
  const missing = action.error instanceof ApiError && Array.isArray(action.error.body.chapters) ? (action.error.body.chapters as string[]) : [];
  return (
    <div className="stack" style={{ gap: 6, alignItems: 'flex-end' }}>
      <Button busy={action.busy} onClick={() => void action.run(() => api(`/v1/studio/courses/${course.id}/submit`, { method: 'POST' })).then((ok) => ok && onDone())}>
        Send for review
      </Button>
      <ErrorNote error={action.error} />
      {missing.length ? <span className="small muted">Waiting on: {missing.join(', ')}</span> : null}
    </div>
  );
}

function Details({ course, options, editable, priceLocked, onSaved }: { course: StudioCourse; options: StudioOptions; editable: boolean; priceLocked: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({
    title: course.title,
    description: course.description ?? '',
    level: course.level,
    language: course.language,
    equipment: course.equipment.join(', '),
    cautions: course.cautions ?? '',
    pricePointId: course.pricePointId ?? '',
  });
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm({ ...form, [key]: e.target.value });
  };
  const save = () =>
    action
      .run(() =>
        api(`/v1/studio/courses/${course.id}`, {
          method: 'PATCH',
          body: {
            title: form.title.trim(),
            description: form.description.trim(),
            level: form.level,
            language: form.language,
            equipment: form.equipment
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
            cautions: form.cautions.trim(),
            pricePointId: priceLocked ? undefined : form.pricePointId || undefined,
          },
        }),
      )
      .then((ok) => {
        if (!ok) return;
        setSaved(true);
        onSaved();
      });

  return (
    <Card title="Course details">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <div className="form-grid">
            <Field label="Title">
              <input value={form.title} onChange={set('title')} maxLength={120} />
            </Field>
            <Field
              label="Price"
              hint={
                course.isFree
                  ? 'This is the free course, so members pay nothing while it stays free.'
                  : priceLocked
                    ? 'A live course keeps its price, because members bought it at this one. Write to the Embodha team if it has to change.'
                    : 'Prices include GST in India.'
              }
            >
              <select value={form.pricePointId} onChange={set('pricePointId')} disabled={priceLocked}>
                <option value="">Choose…</option>
                {options.coursePrices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.inr} in India · {p.usd} elsewhere
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Level">
              <select value={form.level} onChange={set('level')}>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
                <option value="all">All levels</option>
              </select>
            </Field>
            <Field label="Language">
              <select value={form.language} onChange={set('language')}>
                <option value="en">English</option>
                <option value="hi">Hindi</option>
              </select>
            </Field>
          </div>
          <Field label="Description" hint="Two or three sentences: who it's for and what changes after it.">
            <textarea value={form.description} onChange={set('description')} maxLength={5000} />
          </Field>
          <div className="form-grid">
            <Field label="Equipment" hint="Separate with commas, e.g. Mat, Cushion.">
              <input value={form.equipment} onChange={set('equipment')} />
            </Field>
            <Field label="Who should sit this out" hint="Shown on the course page before anyone starts.">
              <input value={form.cautions} onChange={set('cautions')} maxLength={2000} />
            </Field>
          </div>
        </fieldset>
        {editable ? (
          <div className="row">
            <Button type="submit" busy={action.busy}>
              Save details
            </Button>
            {saved ? <span className="small muted">Saved.</span> : null}
            <ErrorNote error={action.error} />
          </div>
        ) : null}
      </form>
    </Card>
  );
}

function Chapters({ course, editable, onChange }: { course: StudioCourse; editable: boolean; onChange: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'video' | 'audio'>('video');
  const add = useAction();
  const move = useAction();
  const chapters = [...course.chapters].sort((a, b) => a.sort - b.sort);

  const reorder = (from: number, to: number) => {
    const ids = chapters.map((c) => c.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void move.run(() => api(`/v1/studio/courses/${course.id}/chapter-order`, { method: 'POST', body: { ids } })).then((ok) => ok && onChange());
  };

  return (
    <Card title="Chapters">
      {chapters.length ? (
        <div>
          {chapters.map((chapter, i) => (
            <div className="chapter" key={chapter.id}>
              <div className="chapter-order">
                {editable ? (
                  <>
                    <button type="button" aria-label="Move up" disabled={i === 0 || move.busy} onClick={() => reorder(i, i - 1)}>
                      ▲
                    </button>
                    <button type="button" aria-label="Move down" disabled={i === chapters.length - 1 || move.busy} onClick={() => reorder(i, i + 1)}>
                      ▼
                    </button>
                  </>
                ) : (
                  <span className="muted">{i + 1}</span>
                )}
              </div>
              <ChapterBody chapter={chapter} editable={editable} removable={editable && (course.status === 'draft' || Boolean(chapter.isNew))} onChange={onChange} />
            </div>
          ))}
        </div>
      ) : (
        <Empty>No chapters yet. Each chapter is one video or one audio track; members see them in this order.</Empty>
      )}
      <ErrorNote error={move.error} />
      {editable ? (
        <form
          className="inline-form"
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            void add
              .run(() => api(`/v1/studio/courses/${course.id}/chapters`, { method: 'POST', body: { title: title.trim(), type } }))
              .then((ok) => {
                if (!ok) return;
                setTitle('');
                onChange();
              });
          }}
        >
          <Field label="New chapter">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Day 1: Wake the spine" maxLength={120} />
          </Field>
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as 'video' | 'audio')}>
              <option value="video">Video</option>
              <option value="audio">Audio only</option>
            </select>
          </Field>
          <Button type="submit" variant="secondary" busy={add.busy} disabled={title.trim().length < 2}>
            Add chapter
          </Button>
          <ErrorNote error={add.error} />
        </form>
      ) : null}
    </Card>
  );
}

function ChapterBody({ chapter, editable, removable, onChange }: { chapter: StudioChapter; editable: boolean; removable: boolean; onChange: () => void }) {
  const [title, setTitle] = useState(chapter.title);
  const action = useAction();
  const patch = (body: object) => action.run(() => api(`/v1/studio/chapters/${chapter.id}`, { method: 'PATCH', body })).then((ok) => ok && onChange());

  return (
    <>
      <div className="stack" style={{ gap: 8 }}>
        {editable ? (
          <input
            aria-label="Chapter title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() !== chapter.title && title.trim().length >= 2 && void patch({ title: title.trim() })}
          />
        ) : (
          <strong>{chapter.title}</strong>
        )}
        {chapter.isNew ? (
          <span className="small muted">
            <Badge tone="amber">New</Badge> Joins the course when your changes are approved.
          </span>
        ) : null}
        <Toggle checked={chapter.isPreview} disabled={action.busy || !editable} onChange={(isPreview) => void patch({ isPreview })} label="Free preview: anyone can watch, even without an account" />
        <ChapterUpload chapter={chapter} editable={editable} onChange={onChange} />
        <ErrorNote error={action.error} />
      </div>
      {removable ? (
        <Button
          variant="danger"
          busy={action.busy}
          onClick={() => {
            if (window.confirm(`Remove “${chapter.title}”? Its video goes too.`)) {
              void action.run(() => api(`/v1/studio/chapters/${chapter.id}`, { method: 'DELETE' })).then((ok) => ok && onChange());
            }
          }}
        >
          Remove
        </Button>
      ) : (
        <span />
      )}
    </>
  );
}
