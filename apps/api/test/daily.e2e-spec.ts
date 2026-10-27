import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mediaAssets, staffRoles, users } from '../src/db/schema';
import { AudioService } from '../src/media/audio.service';
import { BunnyService } from '../src/media/bunny.service';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

describe('The Today screen: quote, photo and video', () => {
  let t: TestApp;
  let admin: string;
  let dir: string;
  const stored: { path: string; type: string }[] = [];
  const day = '2026-11-14';
  const home = async () => (await t.http().get(`/v1/home?date=${day}`).expect(200)).body;

  beforeAll(async () => {
    t = await createTestApp();
    admin = (await signIn(t, 'editor@embodha.test')).accessToken;
    const [editor] = await t.db.select().from(users).where(eq(users.email, 'editor@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: editor.id, role: 'content' });
    jest.spyOn(t.app.get(AudioService), 'put').mockImplementation(async (where, _file, type) => {
      stored.push({ path: where, type: type ?? '' });
    });
    jest.spyOn(t.app.get(BunnyService), 'createVideo').mockResolvedValue({ guid: 'clip-guid-1' });
    jest.spyOn(t.app.get(BunnyService), 'getVideo').mockRejectedValue(new Error('not in tests'));
    dir = mkdtempSync(path.join(tmpdir(), 'daily-'));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xF6A6CB:s=2000x1000', '-frames:v', '1', path.join(dir, 'sunrise.png')]);
    writeFileSync(path.join(dir, 'not-a-photo.jpg'), 'Just some words with a photo name.');
  });
  afterAll(async () => {
    await t.close();
  });

  it('puts a photo and a short video next to the quote, the video once Bunny has finished it', async () => {
    await t.http().put(`/v1/admin/daily/${day}`).set(bearer(admin)).send({ text: 'Rest is part of the practice.', author: 'Asha Rao' }).expect(200);

    const photo = await t
      .http()
      .post(`/v1/admin/daily/${day}/image`)
      .set(bearer(admin))
      .field('caption', 'First light over the Western Ghats')
      .field('credit', 'Meera Iyer')
      .attach('file', path.join(dir, 'sunrise.png'))
      .expect(201);
    // Shrunk to 1,600 px wide, saved as a JPEG.
    expect(photo.body).toMatchObject({ type: 'image', width: 1600, height: 800, text: 'First light over the Western Ghats', author: 'Meera Iyer' });
    expect(stored).toEqual([{ path: expect.stringMatching(/^daily\/2026-11-14-[0-9a-f]{8}\.jpg$/), type: 'image/jpeg' }]);

    const refused = await t.http().post(`/v1/admin/daily/${day}/image`).set(bearer(admin)).attach('file', path.join(dir, 'not-a-photo.jpg')).expect(400);
    expect(refused.body.code).toBe('not_image');

    const clip = await t.http().post(`/v1/admin/daily/${day}/clip`).set(bearer(admin)).send({ caption: 'Sixty seconds of rain on the window' }).expect(201);
    expect(clip.body).toMatchObject({ status: 'uploading', tus: { endpoint: expect.stringContaining('tusupload'), headers: expect.objectContaining({ VideoId: 'clip-guid-1' }) } });

    // Until Bunny has finished the video, the app shows the quote and the photo only.
    let today = await home();
    expect(today.daily).toEqual({ type: 'quote', text: 'Rest is part of the practice.', author: 'Asha Rao' });
    expect(today.dailyImage).toMatchObject({ caption: 'First light over the Western Ghats', credit: 'Meera Iyer', width: 1600, height: 800 });
    expect(today.dailyImage.url).toContain(`audio-test.b-cdn.net/${stored[0].path}`);
    expect(today.dailyClip).toBeNull();

    await t.db.update(mediaAssets).set({ status: 'ready', durationS: 58 }).where(eq(mediaAssets.id, clip.body.mediaId));
    today = await home();
    expect(today.dailyClip).toEqual({
      url: expect.stringMatching(/^https:\/\/vz-test\.b-cdn\.net\/bcdn_token=.+\/clip-guid-1\/playlist\.m3u8$/), // signed like a chapter
      thumbnailUrl: 'https://vz-test.b-cdn.net/clip-guid-1/thumbnail.jpg',
      durationS: 58,
      caption: 'Sixty seconds of rain on the window',
    });

    const list = (await t.http().get(`/v1/admin/daily?from=${day}`).set(bearer(admin)).expect(200)).body;
    expect(list.map((item: { type: string }) => item.type)).toEqual(['clip', 'image', 'quote']);
    expect(list[1].media).toMatchObject({ status: 'ready', preview: expect.stringContaining('audio-test.b-cdn.net/daily/') });

    // Taking the photo away leaves the quote and the video.
    await t.http().delete(`/v1/admin/daily/${day}/image`).set(bearer(admin)).expect(204);
    await t.http().delete(`/v1/admin/daily/${day}/video`).set(bearer(admin)).expect(400);
    today = await home();
    expect(today.dailyImage).toBeNull();
    expect(today.daily).not.toBeNull();
    expect(today.dailyClip).not.toBeNull();
  });

  it('is for content staff only', async () => {
    const member = await signIn(t, 'member@embodha.test');
    await t.http().post(`/v1/admin/daily/${day}/image`).set(bearer(member.accessToken)).attach('file', path.join(dir, 'sunrise.png')).expect(403);
    await t.http().post(`/v1/admin/daily/${day}/clip`).set(bearer(member.accessToken)).send({}).expect(403);
  });
});
