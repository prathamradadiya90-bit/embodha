import { and, eq } from 'drizzle-orm';
import { auditLog, chapters, courses, mediaAssets, pricePoints, staffRoles, users } from '../src/db/schema';
import { BunnyService } from '../src/media/bunny.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

describe('Changing a live course', () => {
  let t: TestApp;
  let f: Fixtures;
  let asha: string;
  let admin: string;
  let added: string;
  const call = (token: string, method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object) => t.http()[method](path).set(bearer(token)).send(body);
  const course = () => `/v1/studio/courses/${f.paid.id}`;
  const members = async () => (await t.http().get('/v1/courses/gentle-spine').expect(200)).body;
  const finish = (id: string) => t.db.update(mediaAssets).set({ status: 'ready', durationS: 540 }).where(eq(mediaAssets.id, id));

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    jest.spyOn(t.app.get(BunnyService), 'createVideo').mockResolvedValue({ guid: 'video-guid-rest' });
    jest.spyOn(t.app.get(BunnyService), 'getVideo').mockRejectedValue(new Error('not in tests'));
    asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    admin = (await signIn(t, 'editor@embodha.test')).accessToken;
    const [editor] = await t.db.select().from(users).where(eq(users.email, 'editor@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: editor.id, role: 'content' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('lets the instructor edit a copy while members keep the live course', async () => {
    await call(asha, 'patch', course(), { title: 'Gentle Spine, 7 Days', description: 'Seven short mornings.' }).expect(200);
    await call(asha, 'patch', `/v1/studio/chapters/${f.locked.id}`, { title: 'Day 2: Hips', isPreview: true }).expect(200);
    const chapter = await call(asha, 'post', `${course()}/chapters`, { title: 'Day 4: Rest', type: 'video' }).expect(201);
    expect(chapter.body).toMatchObject({ title: 'Day 4: Rest', isNew: true, sort: 4 });
    added = chapter.body.id;
    const upload = await call(asha, 'post', `/v1/studio/chapters/${added}/upload`).expect(201);
    await call(asha, 'get', `/v1/studio/media/${upload.body.mediaId}`).expect(200);
    // Put the new chapter before Day 3.
    await call(asha, 'post', `${course()}/chapter-order`, { ids: [f.preview.id, f.locked.id, added, f.processing.id] }).expect(200);

    // Nothing reached members: same title, same three chapters, Day 2 still locked.
    const live = await members();
    expect(live.title).toBe('gentle-spine');
    expect(live.chapters.map((c: { title: string }) => c.title)).toEqual(['Day 1', 'Day 2', 'Day 3']);
    expect(await t.db.select().from(chapters).where(eq(chapters.id, added))).toEqual([]);

    const view = (await call(asha, 'get', course()).expect(200)).body;
    expect(view).toMatchObject({ title: 'Gentle Spine, 7 Days', status: 'published', changes: { state: 'editing', lastDecision: null } });
    expect(view.chapters.map((c: { title: string; isNew: boolean }) => [c.title, c.isNew])).toEqual([
      ['Day 1', false],
      ['Day 2: Hips', false],
      ['Day 4: Rest', true],
      ['Day 3', false],
    ]);

    // A live chapter stays; a new one can go. The price stays too.
    expect((await call(asha, 'delete', `/v1/studio/chapters/${f.preview.id}`).expect(409)).body.code).toBe('live_chapter');
    const scratch = await call(asha, 'post', `${course()}/chapters`, { title: 'Scratch', type: 'audio' }).expect(201);
    await call(asha, 'delete', `/v1/studio/chapters/${scratch.body.id}`).expect(204);
    const [cheaper] = await t.db.insert(pricePoints).values({ code: 'C499', kind: 'course', inrPaise: 49_900, usdCents: 600 }).returning();
    expect((await call(asha, 'patch', course(), { pricePointId: cheaper.id }).expect(409)).body.code).toBe('price_locked');

    // Day 3's video and the new one are still processing, so it can't go to admin yet.
    const early = await call(asha, 'post', `${course()}/changes/submit`).expect(409);
    expect(early.body).toMatchObject({ code: 'chapters_not_ready', chapters: ['Day 4: Rest', 'Day 3'] });
    await finish(upload.body.mediaId);
    await finish(f.processing.mediaAssetId!);
    expect((await call(asha, 'post', `${course()}/changes/submit`).expect(200)).body.changes.state).toBe('in_review');
    expect((await call(asha, 'patch', course(), { title: 'Another' }).expect(409)).body.code).toBe('changes_in_review');
  });

  it('shows admin what changed, and sending it back keeps the instructor’s work', async () => {
    const list = (await call(admin, 'get', '/v1/admin/courses').expect(200)).body;
    expect(list[0]).toMatchObject({ id: f.paid.id, changesWaitingSince: expect.any(String) });
    expect((await call(admin, 'get', '/v1/admin/overview').expect(200)).body.reviewQueue).toEqual([expect.objectContaining({ id: f.paid.id, kind: 'changes' })]);

    const { body } = await call(admin, 'get', `/v1/admin/courses/${f.paid.id}/changes`).expect(200);
    expect(body.items).toEqual([
      { what: 'Title', before: 'gentle-spine', after: 'Gentle Spine, 7 Days' },
      { what: 'Description', before: null, after: 'Seven short mornings.' },
      { what: 'Chapter renamed', before: 'Day 2', after: 'Day 2: Hips' },
      { what: 'Free preview', after: 'Day 2: Hips: now free to preview' },
      { what: 'New chapter', after: 'Day 4: Rest (video), as chapter 3' },
    ]);

    await call(admin, 'post', `/v1/admin/courses/${f.paid.id}/changes`, { decision: 'return' }).expect(400);
    await call(admin, 'post', `/v1/admin/courses/${f.paid.id}/changes`, { decision: 'return', comments: 'Keep Day 2 locked; it is the heart of the course.' }).expect(200);
    const view = (await call(asha, 'get', course()).expect(200)).body;
    expect(view).toMatchObject({ title: 'Gentle Spine, 7 Days', changes: { state: 'editing', lastDecision: { decision: 'rejected', comments: 'Keep Day 2 locked; it is the heart of the course.' } } });
    await call(asha, 'patch', `/v1/studio/chapters/${f.locked.id}`, { isPreview: false }).expect(200);
    await call(asha, 'post', `${course()}/changes/submit`).expect(200);
    // Members can't do any of this.
    await call(asha, 'get', `/v1/admin/courses/${f.paid.id}/changes`).expect(403);
  });

  it('applies everything in one go when approved, and the address stays', async () => {
    await call(admin, 'post', `/v1/admin/courses/${f.paid.id}/changes`, { decision: 'approve' }).expect(200);
    const live = await members();
    expect(live).toMatchObject({ title: 'Gentle Spine, 7 Days', description: 'Seven short mornings.', slug: 'gentle-spine' });
    expect(live.chapters.map((c: { title: string }) => c.title)).toEqual(['Day 1', 'Day 2: Hips', 'Day 4: Rest', 'Day 3']);
    const [rest] = await t.db.select().from(chapters).where(eq(chapters.id, added));
    expect(rest).toMatchObject({ courseId: f.paid.id, sort: 3, durationS: 540, isPreview: false });
    const [day2] = await t.db.select().from(chapters).where(eq(chapters.id, f.locked.id));
    expect(day2).toMatchObject({ title: 'Day 2: Hips', isPreview: false });
    expect(await t.db.select().from(auditLog).where(and(eq(auditLog.action, 'course.changes_approved'), eq(auditLog.entityId, f.paid.id)))).toHaveLength(1);
    expect((await call(asha, 'get', course()).expect(200)).body.changes).toMatchObject({ state: null, lastDecision: { decision: 'approved' } });
    await call(admin, 'post', `/v1/admin/courses/${f.paid.id}/changes`, { decision: 'approve' }).expect(409);

    // Second thoughts: start again, then throw the copy away.
    await call(asha, 'patch', course(), { title: 'Never mind' }).expect(200);
    await call(asha, 'delete', `${course()}/changes`).expect(204);
    expect((await call(asha, 'get', course()).expect(200)).body).toMatchObject({ title: 'Gentle Spine, 7 Days', changes: { state: null } });
    const [row] = await t.db.select().from(courses).where(eq(courses.id, f.paid.id));
    expect(row.title).toBe('Gentle Spine, 7 Days');
  });

  it('keeps courses that are with admin for the first time out of reach', async () => {
    const draft = await call(asha, 'post', '/v1/studio/courses', { topicId: f.topic.id, title: 'Quiet Knees' }).expect(201);
    const chapter = await call(asha, 'post', `/v1/studio/courses/${draft.body.id}/chapters`, { title: 'One', type: 'video' }).expect(201);
    await t.db.update(courses).set({ status: 'in_review' }).where(eq(courses.id, draft.body.id));
    expect((await call(asha, 'patch', `/v1/studio/chapters/${chapter.body.id}`, { title: 'Two' }).expect(409)).body.code).toBe('not_draft');
    expect((await call(asha, 'post', `/v1/studio/courses/${draft.body.id}/chapters`, { title: 'Three', type: 'video' }).expect(409)).body.code).toBe('not_draft');
  });
});
