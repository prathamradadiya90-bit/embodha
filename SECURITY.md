# Security review

Reviewed in sprint 5, October 2026. It covers the API, the members' app, and the studio and admin web app, as they are in this repository. It isn't a penetration test: get one done by an outside firm before launch (see the end).

## What's in place

| Area | How it's handled |
|---|---|
| Sign-in | Email codes only, no passwords. A code lasts 10 minutes and gets five tries, and only the newest code works. Each address can ask for five codes an hour, and each IP address has its own limit too. |
| Sessions | Access tokens last 15 minutes. Refresh tokens are stored hashed and swapped on every use; if an old one is used again, the session ends everywhere. Members stay signed in for 60 days of use, staff for 12 hours (new in this review). |
| Who can do what | Each admin role (content, finance, support) is checked by the API on every route, not just hidden in the page. Members can only reach their own notes, purchases, invoices and subscriptions. Tests cover the refusals. |
| Money | Razorpay payments are checked by signature and by asking Razorpay. App Store and Google Play purchases are checked with Apple's and Google's servers, and are tied to the account that made them. Webhooks are signed (Razorpay) or re-checked with the store (Apple, Google) before anything changes. |
| Video and audio | Paid chapters play from signed Bunny links that expire. Uploads go straight to Bunny or, for audio, through ffmpeg in a locked-down mode (new in this review). |
| Private notes | Encrypted at rest (AES-256-GCM) with `NOTES_KEY`. |
| Input | Every request body is validated against a declared shape, and unknown fields are refused. Queries are parameterised through Drizzle; search terms are escaped. |
| Transport and headers | Helmet's headers on the API. CORS is limited to the listed origins, and in production they must be https (new). The studio and admin page carries a Content Security Policy (new). |
| Secrets | From the environment only. In production the API won't start without real mail, Bunny token keys, webhook secrets and the notes key, and it refuses insecure combinations. `.env` files are never in the zips. |
| Personal data | A member can download everything held about them (new). Deleting an account signs them out everywhere, stops their renewals, and erases the account 30 days later; an account with purchases keeps only its payment records (fixed in part 2, see below). Staff changes go to the audit log. |
| Analytics | First-party only: the apps send event names with IDs and screen names, never typed text. The API drops unknown names and limits properties to ten short labels. Members can switch it off on their phone. Events are in the data download and lose their link to the person when the account is erased. |
| Rate limits | 300 requests a minute per IP across the API, tighter limits on sign-in, store checks (30 a minute), app events (120 batches a minute) and data downloads (three a day per member). |

## Fixed in this review

1. **Uploaded audio could steer ffmpeg.** A playlist or "concat" file named `.mp3` would have made ffmpeg read other files on the server, or fetch URLs. Now ffprobe has to recognise a real audio format first, and ffmpeg may only open the one uploaded file. There's a test with exactly such a file.
2. **Staff sessions lasted as long as members'.** Staff can refund money and read members' details, so a stolen staff session matters more. They now end after 12 hours without use (`STAFF_SESSION_TTL_HOURS`).
3. **No policy limiting what the studio and admin page could load.** The session token lives in the browser there, so the build now adds a Content Security Policy. The page runs only its own scripts and talks only to the API and Bunny's upload endpoint.
4. **Store purchase checks had only the general rate limit.** Each one costs a call to Apple or Google, so they're now limited to 30 a minute.
5. **A moderate advisory in js-yaml,** pulled in by the API docs package. It's pinned to the fixed release; `npm audit` on the API is clean.
6. **http origins could be allowed in production.** The API now refuses to start with them.

Found in part 2, while adding analytics to the data download:

7. **Deleted accounts were never erased.** The app promised erasure after 30 days, but nothing did it. An hourly job now erases accounts whose 30 days are up. It finds every table that points at the account in Postgres's own catalogue, so tables added later are covered too. Accounts with purchases keep their payment rows and an empty account row, for the tax records.
8. **Deleting an account didn't stop renewals.** A Razorpay subscription would have gone on charging an account waiting to be erased. Razorpay and Google Play renewals now stop when deletion is asked for. App Store ones can only be stopped by the member, and the app tells them how.

## Known and accepted

- **The web builds keep the session in the browser's local storage.** The policy above and short-lived access tokens limit the damage. Moving to httpOnly cookies would also mean CSRF protection, so it isn't worth it at this size.
- **App build tools have advisories** (Metro, Expo CLI, node-forge for code signing and so on). They run on developer machines and in CI, not in the app people install, and they're fixed by keeping Expo up to date. The shipped app has no known advisories.
- **An App Store or Play purchase with no account tag goes to whoever brings it first.** The app tags every purchase, so this only affects purchases made outside it (offer codes, say). Apple's transaction IDs aren't guessable in practice.
- **Email is the only sign-in.** Anyone who controls a staff member's mailbox controls their staff account. See below.

## Before launch (needs people, not code)

- **Penetration test.** A test by an outside firm against the staging server, covering the API, the studio and admin, and both apps.
- **Staff mailboxes.** Staff sign in with company email addresses, and those mailboxes have two-factor sign-in turned on.
- **Secrets.** Keep them in the host's secret store, not in files on the server, and know how to rotate each one. Changing `NOTES_KEY` makes old notes unreadable, so back it up separately.
- **Web server headers.** On Caddy for both web builds: `Strict-Transport-Security`, `X-Frame-Options: DENY` (or a CSP `frame-ancestors 'none'`), and a Content Security Policy for the members' web build. That build loads Razorpay's checkout script, so its policy has to allow `checkout.razorpay.com`.
- **Backups.** Encrypted, off-site, with one restore actually tested.
- **Keep current.** Run `npm audit` and update dependencies once a month. Watch the API's logs for repeated 401s, 403s and 429s.
- **Outside the database.** Erasing an account doesn't reach copies held elsewhere: Razorpay's customer record, Bunny's logs, mail sent. Say so in the privacy policy, and handle requests about those by hand.
