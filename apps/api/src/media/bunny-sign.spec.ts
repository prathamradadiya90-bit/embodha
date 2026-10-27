import { createHash } from 'node:crypto';
import { signBunnyUrl, tusSignature } from './bunny-sign';

const base64url = (input: string) =>
  createHash('sha256').update(input).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

describe('Bunny signing', () => {
  it('signs a TUS upload as sha256(library + key + expiry + video), hex', () => {
    const expected = createHash('sha256').update('12345api-key1767225600video-1').digest('hex');
    expect(tusSignature('12345', 'api-key', 1767225600, 'video-1')).toBe(expected);
  });

  it('puts a directory token in the path, so HLS segments inherit it', () => {
    const url = signBunnyUrl({
      url: 'https://vz-abc.b-cdn.net/video-1/playlist.m3u8',
      securityKey: 'secret',
      expires: 1767225600,
      tokenPath: '/video-1/',
    });
    const token = base64url('secret/video-1/1767225600token_path=/video-1/');
    expect(url).toBe(`https://vz-abc.b-cdn.net/bcdn_token=${token}&token_path=%2Fvideo-1%2F&expires=1767225600/video-1/playlist.m3u8`);
  });

  it('signs a single file with query parameters', () => {
    const url = signBunnyUrl({ url: 'https://audio.b-cdn.net/course/chapter-1.m4a', securityKey: 'secret', expires: 100 });
    expect(url).toBe(`https://audio.b-cdn.net/course/chapter-1.m4a?token=${base64url('secret/course/chapter-1.m4a100')}&expires=100`);
  });
});
