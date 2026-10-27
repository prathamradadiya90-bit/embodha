import { mp4Heights } from '../media/media.service';
import { downloadable, downloadSizes, estimateBytes, extensionOf, pickHeight } from './files';

const dev = { NODE_ENV: 'development' as const, DEV_SAMPLE_DOWNLOAD_URL: undefined };
const media = (extra: Record<string, unknown>) =>
  ({ id: 'm1', kind: 'video', provider: 'bunny_stream', hostAssetId: 'guid-1', status: 'ready', durationS: 600, downloadHeights: [], ...extra }) as never;

describe('What a phone saves', () => {
  it("reads the MP4 copies off Bunny's video, only once it's finished and only up to 1080p", () => {
    expect(mp4Heights({ status: 3, hasMP4Fallback: true, availableResolutions: '360p,720p,240p,480p,1080p,1440p' })).toEqual([240, 360, 480, 720, 1080]);
    expect(mp4Heights({ status: 3, hasMP4Fallback: false, availableResolutions: '360p,720p' })).toEqual([]); // fallback was off
    expect(mp4Heights({ status: 4, hasMP4Fallback: true, availableResolutions: '360p' })).toEqual([]); // still encoding the rest
    expect(mp4Heights({ status: 3, hasMP4Fallback: true, availableResolutions: null })).toEqual([]);
  });

  it('picks the tallest copy at or under the quality, or the shortest when every copy is taller', () => {
    expect(pickHeight([240, 360, 480, 720, 1080], 'standard')).toBe(480);
    expect(pickHeight([240, 360, 480, 720, 1080], 'high')).toBe(720);
    expect(pickHeight([240, 360], 'high')).toBe(360); // a phone recording never shot taller
    expect(pickHeight([1080], 'standard')).toBe(1080);
    expect(pickHeight([], 'standard')).toBeNull();
  });

  it("estimates sizes from Bunny's bitrates: a 10-minute class is about 119 MB standard and 229 MB high", () => {
    expect(estimateBytes('video', 480, 600)).toBe(119_400_000);
    expect(estimateBytes('video', 720, 600)).toBe(229_200_000);
    expect(estimateBytes('video', 540, 600)).toBe(229_200_000); // an odd height costs what the next one up does
    expect(estimateBytes('audio', null, 600)).toBe(9_600_000);
    expect(estimateBytes('video', 480, null)).toBeNull();
    expect(downloadSizes({ kind: 'audio', heights: [] }, 1200)).toEqual({ standard: 19_200_000, high: 19_200_000 });
  });

  it('offers a file only where there is one', () => {
    expect(downloadable(media({}), dev)).toBeNull(); // uploaded before MP4 fallback
    expect(downloadable(media({ downloadHeights: [360, 720] }), dev)).toEqual({ kind: 'video', heights: [360, 720] });
    expect(downloadable(media({ downloadHeights: [360], status: 'processing' }), dev)).toBeNull();
    expect(downloadable(media({ kind: 'audio', provider: 'bunny_storage', hostAssetId: 'audio/c/m.m4a' }), dev)).toEqual({ kind: 'audio', heights: [] });
    expect(downloadable(media({ kind: 'image', provider: 'bunny_storage' }), dev)).toBeNull();
  });

  it('saves the development sample only outside production, and only when it is one file', () => {
    const sample = (url: string) => media({ provider: 'dev_sample', hostAssetId: url });
    expect(downloadable(sample('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'), dev)).toBeNull();
    expect(downloadable(sample('http://localhost:8081/sample.mp4'), dev)).toEqual({ kind: 'video', heights: [], sampleUrl: 'http://localhost:8081/sample.mp4' });
    const set = { ...dev, DEV_SAMPLE_DOWNLOAD_URL: 'http://10.0.2.2:8090/bunny.mp4?x=1' };
    const found = downloadable(sample('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'), set)!;
    expect(found.sampleUrl).toBe('http://10.0.2.2:8090/bunny.mp4?x=1');
    expect(extensionOf(found)).toBe('mp4');
    expect(extensionOf({ kind: 'video', heights: [], sampleUrl: 'http://localhost:8081/sample.webm' })).toBe('webm');
    expect(extensionOf({ kind: 'audio', heights: [] })).toBe('m4a');
    expect(downloadable(sample('http://localhost:8081/sample.mp4'), { NODE_ENV: 'production', DEV_SAMPLE_DOWNLOAD_URL: undefined })).toBeNull();
  });
});
