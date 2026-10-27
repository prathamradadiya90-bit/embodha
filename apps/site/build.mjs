// Builds the public site into dist/: each page in src/pages is wrapped in src/layout.html, with the business details
// from site.config.json filled in. `--release` refuses to build while any of those details is missing.
//   node build.mjs [--release] [--config file.json] [--out dir]
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const release = process.argv.includes('--release');
const out = path.resolve(arg('--out') ?? path.join(root, 'dist'));
const config = JSON.parse(readFileSync(path.resolve(arg('--config') ?? path.join(root, 'site.config.json')), 'utf8'));

/** What each detail is, in words, for the warning and for the highlighted gap on the page. */
const REQUIRED = {
  companyName: 'the company’s legal name',
  address: 'the registered address',
  supportEmail: 'the support email address',
  supportPhone: 'a customer-care phone number (India’s e-commerce rules ask for one)',
  grievanceOfficer: 'the Grievance Officer’s name',
  grievanceEmail: 'the Grievance Officer’s email address',
  siteUrl: 'the website’s address, e.g. https://embodha.in',
  city: 'the city whose courts hear disputes',
  emailProvider: 'the company that sends the emails',
  hostingRegion: 'where the servers are',
  backupDays: 'how many days backups are kept',
  effectiveDate: 'the date these policies take effect',
  refundWindowDays: 'the refund window in days (Money settings in admin)',
};
const filled = (key) => String(config[key] ?? '').trim();
const missing = Object.keys(REQUIRED).filter((key) => !filled(key));
if (missing.length) {
  const list = missing.map((key) => `  ${key}: ${REQUIRED[key]}`).join('\n');
  if (release) {
    console.error(`Fill these in site.config.json before a release build:\n${list}`);
    process.exit(1);
  }
  console.warn(`Not filled in yet, so they show highlighted on the pages:\n${list}`);
}

const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const display = (key) => (filled(key) ? escape(filled(key)) : `<mark class="todo">[${escape(REQUIRED[key] ?? key)}]</mark>`);
const href = (key) => (filled(key) ? escape(filled(key)) : '#to-fill');
const tel = (key) => (filled(key) ? `tel:${filled(key).replace(/[^+\d]/g, '')}` : '#to-fill');
// The home page's ways in: the store listings once the apps are out, and the members' web app if it's online.
const stores = () => {
  const apps = [
    filled('appStoreUrl') && `<a class="button" href="${escape(filled('appStoreUrl'))}">Download on the App Store</a>`,
    filled('playStoreUrl') && `<a class="button" href="${escape(filled('playStoreUrl'))}">Get it on Google Play</a>`,
  ].filter(Boolean);
  const buttons = [...apps, filled('webAppUrl') && `<a class="button light" href="${escape(filled('webAppUrl'))}">Open it in your browser</a>`].filter(Boolean);
  return (
    (buttons.length ? `<p class="buttons">${buttons.join(' ')}</p>` : '') +
    (apps.length ? '' : '<p class="soon"><span>Coming soon</span> to the App Store and Google Play.</p>')
  );
};
const fill = (html) =>
  html
    .replace(/\{\{stores\}\}/g, stores)
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()))
    .replace(/\{\{href:(\w+)\}\}/g, (_, key) => href(key))
    .replace(/\{\{tel:(\w+)\}\}/g, (_, key) => tel(key))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => display(key));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const layout = readFileSync(path.join(root, 'src', 'layout.html'), 'utf8');
const paths = [];
for (const file of readdirSync(path.join(root, 'src', 'pages')).filter((f) => f.endsWith('.html')).sort()) {
  const source = readFileSync(path.join(root, 'src', 'pages', file), 'utf8');
  const head = /^<!--([\s\S]*?)-->/.exec(source);
  const meta = Object.fromEntries((head?.[1] ?? '').split('\n').map((line) => line.split(/:\s(.+)/).map((s) => s?.trim())).filter(([key, value]) => key && value));
  const page = fill(layout.replace('{{content}}', source.slice(head?.[0].length ?? 0)).replace(/\{\{title\}\}/g, escape(meta.title ?? 'embodha')).replace(/\{\{description\}\}/g, escape(meta.description ?? '')));
  // Pretty addresses: privacy.html becomes /privacy/. The home page and the 404 page stay at the top.
  const name = file.replace(/\.html$/, '');
  const target = name === 'index' || name === '404' ? path.join(out, file) : path.join(out, name, 'index.html');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, page);
  if (name !== '404') paths.push(name === 'index' ? '/' : `/${name}/`);
}

copyFileSync(path.join(root, 'src', 'styles.css'), path.join(out, 'styles.css'));
copyFileSync(path.join(root, 'src', 'favicon.svg'), path.join(out, 'favicon.svg'));
// The brand's three typefaces, served from the site itself, so a visit doesn't tell a font service who's reading.
const require = createRequire(import.meta.url);
mkdirSync(path.join(out, 'fonts'), { recursive: true });
for (const [pkg, file] of [
  ['@fontsource/italiana', 'italiana-latin-400-normal.woff2'],
  ['@fontsource/anton', 'anton-latin-400-normal.woff2'],
  ['@fontsource/dm-sans', 'dm-sans-latin-400-normal.woff2'],
  ['@fontsource/dm-sans', 'dm-sans-latin-700-normal.woff2'],
]) {
  copyFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files', file), path.join(out, 'fonts', file));
}

const site = filled('siteUrl').replace(/\/$/, '');
writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${site ? `Sitemap: ${site}/sitemap.xml\n` : ''}`);
if (site) {
  const urls = paths.map((p) => `  <url><loc>${escape(site + p)}</loc></url>`).join('\n');
  writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
}
console.log(`Built ${paths.length + 1} pages into ${path.relative(process.cwd(), out) || '.'}`);
