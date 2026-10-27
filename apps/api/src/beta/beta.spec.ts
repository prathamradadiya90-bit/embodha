import { fingerprint, scrub } from './beta.module';

describe('fingerprint', () => {
  const hermes = (line: number) => `TypeError: Cannot read property 'title' of undefined\n    at ChapterRow (address at index.android.bundle:1:${line})\n    at renderWithHooks (address at index.android.bundle:1:99)`;

  it('groups the same problem across builds, phones and IDs', () => {
    expect(fingerprint('crash', "Cannot read property 'title' of undefined", hermes(40213))).toBe(fingerprint('crash', "Cannot read property 'title' of undefined", hermes(51877)));
    expect(fingerprint('error', 'Chapter 4f9c2a1e-77b0-4c3d-9a8e-1b2c3d4e5f60 not found (attempt 2)', null)).toBe(fingerprint('error', 'Chapter 0b81d3c4-12aa-4f00-8abc-000000000001 not found (attempt 3)', null));
    expect(fingerprint('error', 'Request failed with status code 502', null)).toBe(fingerprint('error', 'Request failed with status code 503', null));
  });

  it('keeps different problems apart: another function, another message, or a crash against an error', () => {
    const base = fingerprint('crash', 'boom', hermes(1));
    expect(fingerprint('crash', 'boom', hermes(1).replace('ChapterRow', 'CourseCard'))).not.toBe(base);
    expect(fingerprint('crash', 'bang', hermes(1))).not.toBe(base);
    expect(fingerprint('error', 'boom', hermes(1))).not.toBe(base);
  });

  it('reads the top frame from V8, Safari and Firefox stacks too', () => {
    const v8 = 'Error: boom\n    at Object.play (https://app.example.com/_expo/static/js/web/entry-1a2b.js:2:3456)';
    const safari = 'play@https://app.example.com/_expo/static/js/web/entry-1a2b.js:2:3456\nrender@https://app.example.com/x.js:1:1';
    expect(fingerprint('error', 'boom', v8)).toBe(fingerprint('error', 'boom', v8.replace('2:3456', '9:12')));
    expect(fingerprint('error', 'boom', safari)).not.toBe(fingerprint('error', 'boom', safari.replace('play@', 'pause@')));
  });
});

describe('scrub', () => {
  it('takes email addresses out of messages, and leaves stack frames alone', () => {
    expect(scrub("Couldn't save details for meera.k+yoga@example.co.in")).toBe("Couldn't save details for [email]");
    const frame = 'play@https://app.example.com/_expo/static/js/web/entry.js:2:3456';
    expect(scrub(frame)).toBe(frame);
    expect(scrub(null)).toBeNull();
  });
});
