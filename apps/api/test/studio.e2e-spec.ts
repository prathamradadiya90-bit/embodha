import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { chapters, instructors, users } from '../src/db/schema';
import { BunnyService } from '../src/media/bunny.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

describe('Studio uploads', () => {
  let t: TestApp;
  let f: Fixtures;
  let asha: string;
  let chapterId: string;
  let mediaId: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    // Bunny's HTTP API is faked; the signing maths is real.
    const bunny = t.app.get(BunnyService);
    jest.spyOn(bunny, 'createVideo').mockResolvedValue({ guid: 'video-guid-1' });
    jest.spyOn(bunny, 'getVideo').mockResolvedValue({ guid: 'video-guid-1', status: 3, length: 754.4, thumbnailFileName: 'thumbnail.jpg' });
    asha = (await signIn(t, 'asha@embodha.test')).accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  it('keeps members out of the studio', async () => {
    const { accessToken } = await signIn(t, 'member@embodha.test');
    const res = await t.http().get('/v1/studio/courses').set(bearer(accessToken)).expect(403);
    expect(res.body.code).toBe('not_instructor');
  });

  it('creates a draft course and a chapter, then hands out a resumable upload', async () => {
    const course = await t.http().post('/v1/studio/courses').set(bearer(asha)).send({ topicId: f.topic.id, title: 'Hips, Gently' }).expect(201);
    expect(course.body).toMatchObject({ slug: 'hips-gently', status: 'draft', instructorId: f.asha.id });

    const chapter = await t
      .http()
      .post(`/v1/studio/courses/${course.body.id}/chapters`)
      .set(bearer(asha))
      .send({ title: 'Warm up', type: 'video', isPreview: true })
      .expect(201);
    expect(chapter.body).toMatchObject({ sort: 1, isPreview: true });
    chapterId = chapter.body.id;

    const upload = await t.http().post(`/v1/studio/chapters/${chapterId}/upload`).set(bearer(asha)).expect(201);
    const { endpoint, headers } = upload.body.tus;
    expect(endpoint).toBe('https://video.bunnycdn.com/tusupload');
    expect(headers).toMatchObject({ VideoId: 'video-guid-1', LibraryId: '12345' });
    expect(headers.AuthorizationSignature).toBe(
      createHash('sha256').update(`12345test-key${headers.AuthorizationExpire}video-guid-1`).digest('hex'),
    );
    expect(upload.body.status).toBe('uploading');
    mediaId = upload.body.mediaId;
  });

  it('marks the upload ready once Bunny reports encoding finished', async () => {
    await t.http().post('/v1/webhooks/video?secret=wrong').send({ VideoGuid: 'video-guid-1', Status: 3 }).expect(401);
    await t.http().post('/v1/webhooks/video?secret=hook-secret').send({ VideoLibraryId: 12345, VideoGuid: 'video-guid-1', Status: 3 }).expect(200);

    const status = await t.http().get(`/v1/studio/media/${mediaId}`).set(bearer(asha)).expect(200);
    expect(status.body).toMatchObject({ status: 'ready', durationS: 754, thumbnailUrl: 'https://vz-test.b-cdn.net/video-guid-1/thumbnail.jpg' });
    const [chapter] = await t.db.select().from(chapters).where(eq(chapters.id, chapterId));
    expect(chapter.durationS).toBe(754);
  });

  it("won't let one instructor touch another's chapter", async () => {
    const [ravi] = await t.db.insert(users).values({ email: 'ravi@embodha.test' }).returning();
    await t.db.insert(instructors).values({ userId: ravi.id, displayName: 'Ravi', slug: 'ravi', status: 'approved' });
    const { accessToken } = await signIn(t, 'ravi@embodha.test');
    await t.http().post(`/v1/studio/chapters/${chapterId}/upload`).set(bearer(accessToken)).expect(404);
    await t.http().get(`/v1/studio/media/${mediaId}`).set(bearer(accessToken)).expect(404);
  });

  it('hands back the same unfinished upload, so a reload can resume it', async () => {
    const bunny = t.app.get(BunnyService);
    const create = jest.spyOn(bunny, 'createVideo').mockResolvedValueOnce({ guid: 'video-guid-2' });
    const course = await t.http().post('/v1/studio/courses').set(bearer(asha)).send({ topicId: f.topic.id, title: 'Slow Mornings' }).expect(201);
    const chapter = await t.http().post(`/v1/studio/courses/${course.body.id}/chapters`).set(bearer(asha)).send({ title: 'Day 1', type: 'video' }).expect(201);
    const calls = create.mock.calls.length;
    const first = await t.http().post(`/v1/studio/chapters/${chapter.body.id}/upload`).set(bearer(asha)).expect(201);
    const again = await t.http().post(`/v1/studio/chapters/${chapter.body.id}/upload`).set(bearer(asha)).expect(201);
    expect(again.body.mediaId).toBe(first.body.mediaId);
    expect(again.body.tus.headers.VideoId).toBe('video-guid-2');
    expect(create.mock.calls.length).toBe(calls + 1);
  });

  it('reorders and removes draft chapters', async () => {
    const course = await t.http().post('/v1/studio/courses').set(bearer(asha)).send({ topicId: f.topic.id, title: 'Three Short Ones' }).expect(201);
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      ids.push((await t.http().post(`/v1/studio/courses/${course.body.id}/chapters`).set(bearer(asha)).send({ title, type: 'video' }).expect(201)).body.id);
    }
    const reordered = await t.http().post(`/v1/studio/courses/${course.body.id}/chapter-order`).set(bearer(asha)).send({ ids: [...ids].reverse() }).expect(200);
    expect(reordered.body.chapters.map((c: { title: string }) => c.title)).toEqual(['Three', 'Two', 'One']);
    await t.http().post(`/v1/studio/courses/${course.body.id}/chapter-order`).set(bearer(asha)).send({ ids: ids.slice(1) }).expect(400);
    await t.http().delete(`/v1/studio/chapters/${ids[1]}`).set(bearer(asha)).expect(204);
    const after = await t.http().get(`/v1/studio/courses/${course.body.id}`).set(bearer(asha)).expect(200);
    expect(after.body.chapters.map((c: { title: string }) => c.title)).toEqual(['Three', 'One']);
  });

  it("lets the instructor switch their monthly subscription off and on", async () => {
    const options = await t.http().get('/v1/studio/options').set(bearer(asha)).expect(200);
    expect(options.body.planPrices).toEqual([{ id: expect.any(String), code: 'S499', inr: '₹499', usd: '$6' }]);
    await t.http().put('/v1/studio/plan').set(bearer(asha)).send({ enabled: false }).expect(200);
    expect((await t.http().get('/v1/courses/gentle-spine').expect(200)).body.instructorSubscription).toBeNull();
    await t.http().put('/v1/studio/plan').set(bearer(asha)).send({ enabled: true }).expect(200);
    expect((await t.http().get('/v1/courses/gentle-spine').expect(200)).body.instructorSubscription).not.toBeNull();
    expect((await t.http().get('/v1/studio/me').set(bearer(asha)).expect(200)).body.plan).toEqual({
      enabled: true,
      pricePointId: options.body.planPrices[0].id,
    });
  });
});
