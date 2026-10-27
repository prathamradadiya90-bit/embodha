// The site's build: filled-in details, working links, nothing loaded from elsewhere, and a release build that
// refuses to go out with gaps. Run: npm test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filled = {
  companyName: 'Example Wellness Private Limited',
  address: '12 Example Road, Bengaluru 560001',
  supportEmail: 'help@example.com',
  supportPhone: '+91 80 1234 5678',
  grievanceOfficer: 'A. Person',
  grievanceEmail: 'privacy@example.com',
  siteUrl: 'https://example.com',
  city: 'Bengaluru',
  emailProvider: 'Example Mail',
  hostingRegion: 'India',
  backupDays: '30',
  effectiveDate: '1 December 2026',
  refundWindowDays: '7',
  appStoreUrl: '',
  playStoreUrl: 'https://play.google.com/store/apps/details?id=com.embodha.app',
  webAppUrl: 'https://app.example.com',
};

function build(config, ...flags) {
  const dir = mkdtempSync(path.join(tmpdir(), 'site-'));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const out = path.join(dir, 'dist');
  const run = spawnSync(process.execPath, [path.join(root, 'build.mjs'), '--config', path.join(dir, 'config.json'), '--out', out, ...flags], { encoding: 'utf8' });
  return { out, status: run.status, stderr: run.stderr, stdout: run.stdout };
}
const pages = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => f.endsWith('.html'));

test('a release build with every detail fills them all in, with no gaps left', () => {
  const { out, status, stderr } = build(filled, '--release');
  assert.equal(status, 0, stderr);
  for (const page of ['index.html', '404.html', 'privacy/index.html', 'terms/index.html', 'refunds/index.html', 'delete-account/index.html', 'support/index.html', 'pricing/index.html', 'shipping/index.html']) {
    assert.ok(existsSync(path.join(out, page)), page);
  }
  for (const file of pages(out)) {
    const html = readFileSync(file, 'utf8');
    assert.ok(!html.includes('{{'), `${file} has an unfilled {{`);
    assert.ok(!html.includes('class="todo"'), `${file} has a gap`);
  }
  const refunds = readFileSync(path.join(out, 'refunds/index.html'), 'utf8');
  assert.match(refunds, /within 7 days of buying a course/);
  const home = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /Get it on Google Play/);
  assert.ok(!home.includes('App Store</a>') && !home.includes('Coming soon'));
  assert.match(home, /<a href="tel:\+918012345678">\+91 80 1234 5678<\/a>/);
  assert.equal((readFileSync(path.join(out, 'sitemap.xml'), 'utf8').match(/<loc>/g) ?? []).length, 8);
  assert.match(readFileSync(path.join(out, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
});

test('until the apps are in the stores, the home page says so, and still links to the web app', () => {
  const { out } = build({ ...filled, playStoreUrl: '' });
  const home = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /<span>Coming soon<\/span> to the App Store and Google Play/);
  assert.match(home, /<a class="button light" href="https:\/\/app\.example\.com">Open it in your browser<\/a>/);
  assert.ok(!home.includes('Google Play</a>'));
  const bare = readFileSync(path.join(build({ ...filled, playStoreUrl: '', webAppUrl: '' }).out, 'index.html'), 'utf8');
  assert.ok(!bare.includes('class="buttons"') && bare.includes('Coming soon'));
});

test('every link between pages, and every #section, leads somewhere', () => {
  const { out } = build(filled);
  for (const file of pages(out)) {
    const html = readFileSync(file, 'utf8');
    for (const [, target] of html.matchAll(/href="(\/[^"]*)"/g)) {
      const [address, anchor] = target.split('#');
      const local = path.join(out, address);
      const resolved = address.endsWith('/') || statSync(local, { throwIfNoEntry: false })?.isDirectory() ? path.join(local, 'index.html') : local;
      assert.ok(existsSync(resolved), `${path.relative(out, file)} links to ${target}, which isn't there`);
      if (anchor) assert.ok(readFileSync(resolved, 'utf8').includes(`id="${anchor}"`), `${target}: no #${anchor} on that page`);
    }
  }
});

test('pages run no scripts and load nothing from other sites', () => {
  const { out } = build(filled);
  for (const file of pages(out)) {
    const html = readFileSync(file, 'utf8');
    assert.ok(!/<script/i.test(html), `${file} has a script`);
    assert.ok(!/<link[^>]+href="https?:/i.test(html), `${file} loads a stylesheet or icon from elsewhere`);
  }
  const css = readFileSync(path.join(out, 'styles.css'), 'utf8');
  assert.ok(!/url\(['"]?https?:/i.test(css), 'the stylesheet loads something from elsewhere');
  for (const font of css.matchAll(/url\('(\/fonts\/[^']+)'\)/g)) assert.ok(existsSync(path.join(out, font[1])), `${font[1]} is missing`);
});

test('a missing detail stops a release build, and shows up highlighted in a preview', () => {
  const gap = { ...filled, grievanceOfficer: '' };
  const release = build(gap, '--release');
  assert.equal(release.status, 1);
  assert.match(release.stderr, /grievanceOfficer: the Grievance Officer’s name/);
  const preview = build(gap);
  assert.equal(preview.status, 0);
  assert.match(readFileSync(path.join(preview.out, 'privacy/index.html'), 'utf8'), /<mark class="todo">\[the Grievance Officer’s name\]<\/mark>/);
});
