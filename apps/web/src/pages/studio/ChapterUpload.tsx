import { useEffect, useRef, useState } from 'react';
import { Upload } from 'tus-js-client';
import { api, API_URL, authHeader, errorText } from '../../lib/api';
import { duration, megabytes } from '../../lib/format';
import type { MediaState, StudioChapter, UploadTicket } from '../../lib/types';
import { Badge, Button } from '../../ui/kit';

type Phase = 'idle' | 'starting' | 'uploading' | 'paused' | 'processing' | 'ready' | 'failed';

const phaseFrom = (chapter: StudioChapter): Phase =>
  chapter.media?.status === 'ready' ? 'ready' : chapter.media?.status === 'processing' ? 'processing' : chapter.media?.status === 'failed' ? 'failed' : 'idle';

/**
 * Sends the file straight from the browser to Bunny over tus, in resumable pieces. A dropped connection retries on
 * its own; after a reload or a closed laptop, choosing the same file again carries on from where it stopped.
 */
export function ChapterUpload({ chapter, editable, onChange }: { chapter: StudioChapter; editable: boolean; onChange: () => void }) {
  const [phase, setPhase] = useState<Phase>(() => phaseFrom(chapter));
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [error, setError] = useState<string | null>(chapter.media?.error ?? null);
  const upload = useRef<Upload | null>(null);
  const mediaId = useRef<string | null>(chapter.media?.id ?? null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase !== 'uploading') return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  // Bunny encodes the streaming versions after the upload; ask every few seconds until it's done.
  useEffect(() => {
    const id = mediaId.current;
    if (phase !== 'processing' || !id) return;
    const timer = setInterval(() => {
      api<MediaState>(`/v1/studio/media/${id}`)
        .then((state) => {
          if (state.status === 'ready') setPhase('ready');
          else if (state.status === 'failed') {
            setPhase('failed');
            setError(state.error ?? "Bunny couldn't process this file. Try exporting it again as MP4.");
          } else return;
          onChange();
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [phase, onChange]);

  // Leaving the page pauses the upload rather than throwing it away.
  useEffect(() => () => void upload.current?.abort(), []);

  const isAudio = chapter.type === 'audio';

  // Audio is small next to video, so it goes through the API, which evens out the loudness before storing it.
  const sendAudio = async (file: File) => {
    try {
      await api('/v1/studio/me'); // refreshes an expired session before the upload starts
      const id = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/v1/studio/chapters/${chapter.id}/audio`);
        Object.entries(authHeader()).forEach(([key, value]) => xhr.setRequestHeader(key, value));
        xhr.upload.onprogress = (event) => setProgress({ sent: event.loaded, total: event.total });
        xhr.onload = () => {
          let body: { mediaId?: string; message?: string } = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // not JSON: fall through to the generic message
          }
          if (xhr.status === 202 && body.mediaId) resolve(body.mediaId);
          else reject(new Error(body.message ?? `The upload failed (${xhr.status}).`));
        };
        xhr.onerror = () => reject(new Error('The connection dropped. Choose the file again to retry.'));
        const form = new FormData();
        form.append('file', file);
        setProgress({ sent: 0, total: file.size });
        setPhase('uploading');
        xhr.send(form);
      });
      mediaId.current = id;
      setPhase('processing');
      onChange();
    } catch (e) {
      setPhase('failed');
      setError(errorText(e));
    }
  };

  const start = async (file: File) => {
    if (!file.type.startsWith(isAudio ? 'audio/' : 'video/')) {
      return setError(isAudio ? 'Choose an audio file. MP3, M4A or WAV works best.' : 'Choose a video file. MP4 or MOV works best.');
    }
    setError(null);
    setPhase('starting');
    if (isAudio) return void sendAudio(file);
    try {
      const ticket = await api<UploadTicket>(`/v1/studio/chapters/${chapter.id}/upload`, { method: 'POST' });
      mediaId.current = ticket.mediaId;
      const next = new Upload(file, {
        endpoint: ticket.tus.endpoint,
        headers: Object.fromEntries(Object.entries(ticket.tus.headers).map(([key, value]) => [key, String(value)])),
        metadata: { filetype: file.type, title: chapter.title },
        retryDelays: [0, 3000, 5000, 10000, 20000, 60000, 60000],
        // Tied to the chapter, so the same file picked for two chapters never resumes into the wrong one.
        fingerprint: async () => ['embodha', chapter.id, file.name, file.size, file.lastModified].join(':'),
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => setProgress({ sent, total }),
        onError: (err) => {
          setPhase('failed');
          setError(`The upload stopped (${err.message}). Choose the same file again to carry on from where it stopped.`);
        },
        onSuccess: () => {
          setPhase('processing');
          onChange();
        },
      });
      upload.current = next;
      const previous = await next.findPreviousUploads();
      if (previous.length) next.resumeFromPreviousUpload(previous[0]);
      setProgress({ sent: 0, total: file.size });
      setPhase('uploading');
      next.start();
    } catch (e) {
      setPhase('failed');
      setError(errorText(e));
    }
  };

  const percent = progress.total ? Math.floor((progress.sent / progress.total) * 100) : 0;
  const canPick = editable && (phase === 'idle' || phase === 'failed' || phase === 'ready');

  return (
    <div className="upload">
      {phase === 'ready' ? (
        <span className="small">
          <Badge tone="green">{isAudio ? 'Audio ready' : 'Video ready'}</Badge> {duration(chapter.durationS)}
        </span>
      ) : null}
      {phase === 'processing' ? (
        <span className="small">
          <Badge tone="amber">Processing</Badge>{' '}
          {isAudio
            ? 'Evening out the volume and storing it. Usually under a minute.'
            : 'Bunny is making the streaming versions. Usually a few minutes; you can leave this page.'}
        </span>
      ) : null}
      {phase === 'starting' ? <span className="small muted">Getting the upload ready…</span> : null}
      {phase === 'uploading' || phase === 'paused' ? (
        <>
          <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="row small muted">
            <span>
              {percent}% · {megabytes(progress.sent)} of {megabytes(progress.total)}
              {phase === 'paused' ? ' · paused' : ''}
            </span>
            {isAudio ? null : phase === 'uploading' ? (
              <Button
                variant="quiet"
                onClick={() => {
                  void upload.current?.abort();
                  setPhase('paused');
                }}
              >
                Pause
              </Button>
            ) : (
              <Button
                variant="quiet"
                onClick={() => {
                  upload.current?.start();
                  setPhase('uploading');
                }}
              >
                Resume
              </Button>
            )}
          </div>
        </>
      ) : null}
      {phase === 'idle' && chapter.media?.status === 'uploading' ? (
        <span className="small muted">An earlier upload didn't finish. Choose the same file and it carries on from where it stopped.</span>
      ) : null}
      {error ? <p className="error-note">{error}</p> : null}
      {canPick ? (
        <div>
          <input
            ref={picker}
            type="file"
            accept={isAudio ? 'audio/*' : 'video/*'}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void start(file);
            }}
          />
          <Button variant={phase === 'ready' ? 'quiet' : 'secondary'} onClick={() => picker.current?.click()}>
            {phase === 'ready' ? (isAudio ? 'Replace audio' : 'Replace video') : isAudio ? 'Upload audio' : 'Upload video'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
