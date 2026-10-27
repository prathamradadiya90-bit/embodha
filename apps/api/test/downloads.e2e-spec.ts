import { and, eq } from 'drizzle-orm';
import { chapters, courses, downloadDevices, downloads, entitlements, instructorSubscriptions, mediaAssets, staffRoles, users } from '../src/db/schema';
import { BunnyService } from '../src/media/bunny.service';
import { ExportService } from '../src/privacy/privacy.module';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

const DAY = 86_400_000;
const PHONE = { deviceId: 'phone-pixel-0001', platform: 'android', label: 'Pixel 8' };

describe('Offline downloads', () => {
  let t: TestApp;
  let f: Fixtures;
  let token: string;
  let userId: string;
  const start = (body: Record<string, unknown>, as = token) => t.http().post('/v1/downloads').set(bearer(as)).send({ ...PHONE, quality: 'standard', ...body });
  const check = (chapterIds: string[], device: Record<string, unknown> = PHONE, as = token) =>
    t.http().post('/v1/downloads/check').set(bearer(as)).send({ ...device, chapterIds }).expect(200);
  const heights = (chapterId: string, list: number[]) =>
    t.db.select({ id: chapters.mediaAssetId }).from(chapters).where(eq(chapters.id, chapterId)).then(([c]) => t.db.update(mediaAssets).set({ downloadHeights: list }).where(eq(mediaAssets.id, c.id!)));
  const userIdOf = async (email: string) => (await t.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0].id;

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    token = (await signIn(t, 'downloads@embodha.test')).accessToken;
    userId = await userIdOf('downloads@embodha.test');
  });
  afterAll(async () => {
    await t.close();
  });

  it('shows how big each chapter is to save, once Bunny has made its MP4 copies', async () => {
    let course = (await t.http().get('/v1/courses/morning-breath').set(bearer(token)).expect(200)).body;
    expect(course.chapters[0].downloadBytes).toBeNull(); // uploaded before MP4 fallback was on

    await heights(f.freeChapter.id, [240, 360, 480, 720, 1080]);
    course = (await t.http().get('/v1/courses/morning-breath').set(bearer(token)).expect(200)).body;
    // Ten minutes: about 119 MB at 480p, 229 MB at 720p.
    expect(course.chapters[0].downloadBytes).toEqual({ standard: 119_400_000, high: 229_200_000 });
  });

  it('hands a member a link to the one file, signed for a few hours, with what the phone needs offline', async () => {
    const before = Date.now();
    const res = await start({ chapterId: f.freeChapter.id }).expect(200);
    const media = (await t.db.select().from(mediaAssets).where(eq(mediaAssets.id, f.freeChapter.mediaAssetId!)))[0];
    expect(res.body).toMatchObject({
      chapterId: f.freeChapter.id,
      kind: 'video',
      height: 480,
      extension: 'mp4',
      estimatedBytes: 119_400_000,
      chapter: { id: f.freeChapter.id, title: 'Arrive', type: 'video', durationS: 600 },
      course: { slug: 'morning-breath', title: 'morning-breath', instructor: 'Asha Rao', chapters: [{ id: f.freeChapter.id, title: 'Arrive', type: 'video', durationS: 600 }] },
    });
    const url = new URL(res.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://vz-test.b-cdn.net/${media.hostAssetId}/play_480p.mp4`);
    expect(url.searchParams.get('token')).toMatch(/^[\w-]{20,}$/);
    const expires = Number(url.searchParams.get('expires')) * 1000;
    expect(expires - before).toBeGreaterThan(5.9 * 3600_000);
    expect(expires - before).toBeLessThan(6.1 * 3600_000);
    // Plays offline for 30 days from now, unless the phone checks in again.
    expect(Date.parse(res.body.keepUntil) - before).toBeGreaterThan(29.9 * DAY);

    const high = await start({ chapterId: f.freeChapter.id, quality: 'high' }).expect(200);
    expect(high.body).toMatchObject({ height: 720, estimatedBytes: 229_200_000 });
    expect(high.body.url).toContain('/play_720p.mp4?');
    // The same chapter twice is still one download on one phone.
    expect(await t.db.select().from(downloads).where(eq(downloads.userId, userId))).toEqual([expect.objectContaining({ chapterId: f.freeChapter.id, height: 720 })]);
    expect(await t.db.select().from(downloadDevices).where(eq(downloadDevices.userId, userId))).toEqual([
      expect.objectContaining({ id: PHONE.deviceId, platform: 'android', label: 'Pixel 8' }),
    ]);
  });

  it('keeps downloads to courses the member has: not a locked course, not even its free preview', async () => {
    await heights(f.preview.id, [360, 720]);
    await heights(f.locked.id, [360, 720]);
    await t.http().post('/v1/downloads').send({ ...PHONE, quality: 'standard', chapterId: f.preview.id }).expect(401);
    const locked = await start({ chapterId: f.preview.id }).expect(402);
    expect(locked.body).toMatchObject({ code: 'locked', course: { slug: 'gentle-spine' } });
    await start({ chapterId: f.draftChapter.id }).expect(404); // someone else's draft doesn't exist
    await start({ chapterId: f.locked.id, deviceId: 'no' }).expect(400);

    await t.db.insert(entitlements).values({ userId, courseId: f.paid.id, source: 'grant' });
    const owned = await start({ chapterId: f.locked.id }).expect(200);
    expect(owned.body).toMatchObject({ height: 360, course: { slug: 'gentle-spine', chapters: [{ title: 'Day 1' }, { title: 'Day 2' }, { title: 'Day 3' }] } });
    const processing = await start({ chapterId: f.processing.id }).expect(409);
    expect(processing.body).toMatchObject({ code: 'not_downloadable', message: 'This chapter is still being prepared.' });
  });

  it('saves an audio chapter as the M4A it streams from', async () => {
    const [audio] = await t.db
      .insert(mediaAssets)
      .values({ kind: 'audio', provider: 'bunny_storage', hostAssetId: 'audio/c1/m1.m4a', status: 'ready', durationS: 900 })
      .returning();
    const [chapter] = await t.db.insert(chapters).values({ courseId: f.paid.id, title: 'Day 4: lying down', type: 'audio', sort: 4, durationS: 900, mediaAssetId: audio.id }).returning();
    const res = await start({ chapterId: chapter.id }).expect(200);
    expect(res.body).toMatchObject({ kind: 'audio', height: null, extension: 'm4a', estimatedBytes: 14_400_000 });
    expect(res.body.url).toBe('https://audio-test.b-cdn.net/audio/c1/m1.m4a'); // the test server has no audio token key
    await check([f.freeChapter.id, f.locked.id]); // and the phone deletes it again
  });

  it('keeps downloads to three phones at a time, and lets the member free a place', async () => {
    const phone = (n: number, label: string, platform = 'android') => ({ deviceId: `phone-${n}-000000`, platform, label });
    await start({ chapterId: f.freeChapter.id, ...phone(2, 'iPhone 13', 'ios') }).expect(200);
    await start({ chapterId: f.freeChapter.id, ...phone(3, 'Redmi Note 12') }).expect(200);
    const fourth = await start({ chapterId: f.freeChapter.id, ...phone(4, 'Galaxy Tab A9') }).expect(409);
    expect(fourth.body).toMatchObject({ code: 'device_limit', limit: 3 });
    expect(fourth.body.message).toBe('Your downloads are on 3 phones already (Redmi Note 12, iPhone 13 and Pixel 8). Remove one from Downloads on any phone, then try again.');
    // A phone already on the list can carry on.
    await start({ chapterId: f.locked.id, ...phone(3, 'Redmi Note 12') }).expect(200);

    const list = await t.http().get(`/v1/downloads/devices?deviceId=${PHONE.deviceId}`).set(bearer(token)).expect(200);
    expect(list.body).toMatchObject({ limit: 3, keepDays: 30 });
    expect(list.body.devices.map((d: { label: string; chapters: number; thisPhone: boolean }) => [d.label, d.chapters, d.thisPhone])).toEqual([
      ['Redmi Note 12', 2, false],
      ['iPhone 13', 1, false],
      ['Pixel 8', 2, true],
    ]);

    await t.http().delete('/v1/downloads/devices/phone-2-000000').set(bearer(token)).expect(204);
    await start({ chapterId: f.freeChapter.id, ...phone(4, 'Galaxy Tab A9') }).expect(200);
    // The removed iPhone hears about it at its next check-in, and deletes what it has.
    const removed = await check([f.freeChapter.id], phone(2, 'iPhone 13', 'ios'));
    expect(removed.body.chapters).toEqual([{ chapterId: f.freeChapter.id, keep: false, reason: 'device_removed' }]);

    // A phone that hasn't checked in for the 30 days has stopped playing its downloads, and no longer takes a place.
    await t.db.update(downloadDevices).set({ checkedAt: new Date(Date.now() - 31 * DAY) }).where(eq(downloadDevices.id, 'phone-4-000000'));
    await start({ chapterId: f.freeChapter.id, ...phone(5, 'Moto G84') }).expect(200);
    // Emptying a phone frees its place straight away.
    await check([], phone(5, 'Moto G84'));
    await check([], phone(4, 'Galaxy Tab A9'));
    await check([], phone(3, 'Redmi Note 12'));
    expect((await t.db.select().from(downloadDevices).where(eq(downloadDevices.userId, userId))).map((d) => d.id)).toEqual([PHONE.deviceId]);
  });

  it('renews downloads at each check-in, and says which to delete and why', async () => {
    const renewed = await check([f.freeChapter.id, f.locked.id]);
    expect(renewed.body.chapters).toEqual([
      { chapterId: f.freeChapter.id, keep: true, keepUntil: expect.any(String) },
      { chapterId: f.locked.id, keep: true, keepUntil: expect.any(String) },
    ]);

    // The instructor uploads a better take of Day 2: the saved one is out of date.
    const [retake] = await t.db.insert(mediaAssets).values({ kind: 'video', provider: 'bunny_stream', hostAssetId: 'retake-guid', status: 'ready', durationS: 610, downloadHeights: [480] }).returning();
    await t.db.update(chapters).set({ mediaAssetId: retake.id }).where(eq(chapters.id, f.locked.id));
    expect((await check([f.freeChapter.id, f.locked.id])).body.chapters[1]).toEqual({ chapterId: f.locked.id, keep: false, reason: 'replaced' });
    await start({ chapterId: f.locked.id }).expect(200); // the phone fetches the new one
    expect((await check([f.freeChapter.id, f.locked.id])).body.chapters[1]).toMatchObject({ keep: true });

    // Support takes the course back after a refund.
    await t.db.delete(entitlements).where(and(eq(entitlements.userId, userId), eq(entitlements.courseId, f.paid.id)));
    expect((await check([f.freeChapter.id, f.locked.id])).body.chapters[1]).toEqual({ chapterId: f.locked.id, keep: false, reason: 'access_ended' });

    // A chapter that's deleted, or a phone listing one the server lost track of.
    const [spare] = await t.db.insert(chapters).values({ courseId: f.free.id, title: 'Spare', type: 'video', sort: 9, mediaAssetId: f.freeChapter.mediaAssetId }).returning();
    const adopted = await check([f.freeChapter.id, spare.id]);
    expect(adopted.body.chapters[1]).toMatchObject({ chapterId: spare.id, keep: true });
    await t.db.delete(chapters).where(eq(chapters.id, spare.id));
    expect((await check([f.freeChapter.id, spare.id])).body.chapters[1]).toEqual({ chapterId: spare.id, keep: false, reason: 'gone' });
    expect((await t.db.select().from(downloads).where(and(eq(downloads.userId, userId), eq(downloads.deviceId, PHONE.deviceId)))).map((d) => d.chapterId)).toEqual([f.freeChapter.id]);
  });

  it('lets a subscription’s downloads play to the end of the paid month once it stops renewing, then removes them', async () => {
    const email = 'subscriber@embodha.test';
    const member = (await signIn(t, email)).accessToken;
    const id = await userIdOf(email);
    const phone = { deviceId: 'phone-sub-000001', platform: 'ios', label: 'iPhone 15' };
    const [subscription] = await t.db
      .insert(instructorSubscriptions)
      .values({ userId: id, instructorId: f.asha.id, channel: 'razorpay', externalId: 'sub_offline', status: 'active', currentPeriodEnd: new Date(Date.now() + 20 * DAY) })
      .returning();

    const res = await start({ chapterId: f.preview.id, ...phone }, member).expect(200);
    expect(Date.parse(res.body.keepUntil) - Date.now()).toBeGreaterThan(29 * DAY); // it renews, so the usual 30 days

    await t.db.update(instructorSubscriptions).set({ status: 'cancelled', autoRenew: false, currentPeriodEnd: new Date(Date.now() + 5 * DAY) }).where(eq(instructorSubscriptions.id, subscription.id));
    const [ending] = (await check([f.preview.id], phone, member)).body.chapters;
    expect(ending.keep).toBe(true);
    expect(Math.abs(Date.parse(ending.keepUntil) - (Date.now() + 5 * DAY))).toBeLessThan(60_000);

    await t.db.update(instructorSubscriptions).set({ currentPeriodEnd: new Date(Date.now() - DAY) }).where(eq(instructorSubscriptions.id, subscription.id));
    expect((await check([f.preview.id], phone, member)).body.chapters).toEqual([{ chapterId: f.preview.id, keep: false, reason: 'subscription_ended' }]);
    expect(await t.db.select().from(downloadDevices).where(eq(downloadDevices.userId, id))).toEqual([]); // nothing left, no place taken
  });

  it('records the MP4 copies when Bunny says a video finished, and can read older videos again from the launch checklist', async () => {
    const bunny = t.app.get(BunnyService);
    const [fresh] = await t.db.insert(mediaAssets).values({ kind: 'video', provider: 'bunny_stream', hostAssetId: 'fresh-guid', status: 'processing' }).returning();
    const [older] = await t.db.insert(mediaAssets).values({ kind: 'video', provider: 'bunny_stream', hostAssetId: 'older-guid', status: 'ready', durationS: 300 }).returning();
    const [course] = await t.db.select().from(courses).where(eq(courses.id, f.free.id));
    await t.db.insert(chapters).values([
      { courseId: course.id, title: 'Fresh', type: 'video', sort: 5, mediaAssetId: fresh.id },
      { courseId: course.id, title: 'Older', type: 'video', sort: 6, mediaAssetId: older.id },
    ]);
    const library: Record<string, { status: number; length: number; hasMP4Fallback: boolean; availableResolutions: string }> = {
      'fresh-guid': { status: 3, length: 412.2, hasMP4Fallback: true, availableResolutions: '240p,360p,480p,720p' },
      // Uploaded before MP4 fallback was switched on; re-encoded in Bunny's dashboard later.
      'older-guid': { status: 3, length: 300, hasMP4Fallback: false, availableResolutions: '240p,360p,480p' },
    };
    // Every other video in the fixtures went up before MP4 fallback was on.
    const asBunnyHasIt = (guid: string) => library[guid] ?? { status: 3, length: 600, hasMP4Fallback: false, availableResolutions: '360p,720p' };
    jest.spyOn(bunny, 'getVideo').mockImplementation(async (guid) => ({ guid, ...asBunnyHasIt(guid) }));

    await t.http().post('/v1/webhooks/video?secret=hook-secret').send({ VideoLibraryId: 12345, VideoGuid: 'fresh-guid', Status: 3 }).expect(200);
    expect((await t.db.select().from(mediaAssets).where(eq(mediaAssets.id, fresh.id)))[0]).toMatchObject({ status: 'ready', durationS: 412, downloadHeights: [240, 360, 480, 720] });

    const staff = await signIn(t, 'content@embodha.test');
    await t.db.insert(staffRoles).values({ userId: await userIdOf('content@embodha.test'), role: 'content' });
    const launch = async () => (await t.http().get('/v1/admin/launch').set(bearer(staff.accessToken)).expect(200)).body;
    const videoCheck = (list: { sections: { checks: { key: string }[] }[] }) => list.sections.flatMap((s) => s.checks).find((c) => c.key === 'video_downloads');
    // The older video and the draft's: six finished videos in all.
    expect(videoCheck(await launch())).toMatchObject({
      status: 'todo',
      blocking: false,
      action: 'video_downloads',
      detail: expect.stringMatching(/^2 of 6 videos have no copy the apps can save, so they stream but can't be downloaded\./),
    });

    library['older-guid'] = { ...library['older-guid'], hasMP4Fallback: true };
    const looked = await t.http().post('/v1/admin/launch/video-downloads').set(bearer(staff.accessToken)).expect(200);
    expect(looked.body).toEqual({ looked: 2, saveable: 1, problem: null });
    expect(videoCheck(await launch())).toMatchObject({ status: 'todo', detail: expect.stringMatching(/^1 of 6 videos has no copy the apps can save, so it streams/) });
    const draftGuid = (await t.db.select().from(mediaAssets).where(eq(mediaAssets.id, f.draftChapter.mediaAssetId!)))[0].hostAssetId;
    library[draftGuid] = { status: 3, length: 600, hasMP4Fallback: true, availableResolutions: '360p,720p' };
    expect((await t.http().post('/v1/admin/launch/video-downloads').set(bearer(staff.accessToken)).expect(200)).body).toEqual({ looked: 1, saveable: 1, problem: null });
    expect(videoCheck(await launch())).toMatchObject({ status: 'done', detail: 'All 6 videos have a copy the apps can save.' });
    await t.http().post('/v1/admin/launch/video-downloads').set(bearer(token)).expect(403); // members can't
  });

  it("puts a member's phones and downloads in their data download", async () => {
    const { data } = await t.app.get(ExportService).build(userId);
    expect(data.phonesWithDownloads).toEqual([expect.objectContaining({ id: PHONE.deviceId, label: 'Pixel 8' })]);
    expect(data.downloadedChapters).toEqual([expect.objectContaining({ chapterId: f.freeChapter.id })]);
  });
});
