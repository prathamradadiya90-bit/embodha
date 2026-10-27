# Embodha studio and admin

One web app for two kinds of people. Instructors get the studio; Embodha staff get admin. People who are both see both. It's built with React 19, React Router 7 and Vite, and talks only to the API.

## Studio (approved instructors)

- **Courses.** Start a course as a draft: title, topic, price, level, language, description, equipment and who should sit it out.
- **Chapters.** Add, rename, reorder and remove chapters, and mark any of them as a free preview.
- **Audio chapters.** Up to 500 MB. The API evens out the loudness with ffmpeg and stores the file on Bunny Storage.
- **Uploads.** Videos go straight from the browser to Bunny over tus, in resumable pieces. A dropped connection retries by itself. After a reload or a closed laptop, choosing the same file again carries on from where it stopped. Once Bunny has made the streaming versions, the chapter shows "Video ready".
- **Review.** Send for review. If admin sends it back, their note shows on the course.
- **Changing a live course.** Edit it as you would a draft. The changes wait in a copy, and members see the course as it was until admin approves them. Live chapters can be renamed, reordered or given a new video, but not removed. The price stays.
- **Subscription.** Switch the monthly subscription on or off, and pick its price.
- **This month.** Minutes watched and how many members watched.
- **Earnings.** What you earned this month, what's waiting to be paid, your last payout, and each sale with your share. Website sales are paid after the refund window; sales in the apps once Apple or Google has reported them.

## Admin (staff, by role)

| Page | Who sees it | What it does |
|---|---|---|
| Overview | all staff | This month's numbers, how many things are left before launch, and the review queue |
| Analytics | finance, content | Active members by day, week and month; joined then practised; course page to purchase; after a locked chapter; first-week return; top courses and teachers. For 7, 30 or 90 days |
| Beta health | all staff | The spec's launch bars against their targets, each held until there's enough data: crash-free sessions (99.5%, from 100 sessions), video start on 4G (9 in 10 within 2 seconds, from 30 starts), nobody charged after a teacher switches off, and two weeks of payments matched to the channels' reports on all three channels in rupees and dollars. Behind them: crashes and errors grouped by problem with their stacks, crash-free by platform and app version, start times by connection and by state, chapters sent to a TV and the ones a TV couldn't play, and every switch-off with the renewals due since. For 7, 14 or 30 days |
| Launch checklist | all staff | Whether Embodha can launch: 28 checks of what the server can see for itself (catalogue, keys, webhooks heard from, store products, invoices, email, videos with a copy to download, the website's pages and the sign-in link files, the launch bars), each saying what it found and where to put it right, and eight gates only a person can confirm, signed off by a super admin with a note. Shows everything or only what's left; "Check again" looks at the website and DNS now. A button asks Apple for a test notification, and another (for content staff) reads videos without a downloadable copy from Bunny again |
| Courses | content, support | Publish or send back with a note; review changes to live courses (approve, or send back with a note); pick the free course; archive |
| Instructors | content, finance | Add by email; set each share % (finance); suspend |
| Members | support | Search; suspend or restore; delete (stops renewals, erased after 30 days); add a course to someone's library |
| Reviews | support, content | Read, hide, reply as Embodha, delete |
| Feedback | support, content | What members sent from You, Feedback, with their phone and app version: reply by email, mark handled, reopen |
| Notifications | content | Send to everyone, or by gender, age range or country, now or at a set time (Indian time); cancel a scheduled one before it goes; see what was sent, how many read it, and how many pushes waited for 8 am |
| Catalogue | content | Categories and topics; show or hide them in the app |
| Today screen | content | Two weeks ahead: a line, a photo (shrunk, location data removed) and a short video for each day, all optional |
| Reports | finance, content | Minutes watched per instructor per month, with CSV download |
| Payments | finance, support | Every sale on every channel with its split and, for website sales, the place of supply and the tax (CGST + SGST or IGST); under the net, whether it matches the channel's report yet or the fee is still an estimate; a store sale's share waits for that store's report; test purchases marked; full refunds of Razorpay sales (finance), each with a credit note; the invoice and credit note PDFs |
| Reconciliation | finance | Razorpay's settlements (fetched each night, or for any 31 days on demand) and the stores' monthly reports (uploaded) against the books, sale by sale, for a month: how many sales each channel has matched, what's late, lines that need a look with a box to write down what they were, each report line by line, and the rupee rate for App Store proceeds in dollars |
| Store products | content, finance | Each paid course's and teacher's App Store and Google Play products: made by the server once its keys are set, or linked by hand, with where each stands |
| Payouts | finance | Monthly statements: prepare, close, mark each line paid with the bank reference, CSV |
| GST | finance | A month of Embodha's invoices and credit notes for the returns: sales in India by place of supply with CGST, SGST and IGST, credit notes netted off, exports, the document ranges, and two CSVs (a summary by state and a line-by-line register) |
| Money settings | finance | Dollar rate, refund window, minimum payout, default share, the stores' commission; the seller, its GSTIN (checked, including the check digit) and SAC, and footnotes for invoices |

Super admins see everything. The API checks every role again, and writes each change to the audit log.

## The look

The same as the members' app: Italiana for page titles, Anton for numbers, card titles and buttons, and DM Sans for everything else, all self-hosted through `@fontsource`. The sidebar sits on peach, the numbers on bright tiles (each a different colour, in order), and status badges get flat colours with an ink outline. Tables and forms stay white with hairlines, because that's where the work happens. It's all in `src/styles.css`; the class names didn't change.

## Run it

Start the API first ([LOCAL-SETUP.md](../../LOCAL-SETUP.md) has every step). Then:

```bash
cd apps/web
cp .env.example .env        # VITE_API_URL
npm ci
npm run dev                 # http://localhost:5173
```

Sign in as `admin@embodha.local` for admin, or `asha@embodha.local` for the studio. The code prints in the API's log.

Uploads need the Bunny keys in the API's `.env`. Without them, the upload button says so.

## Build and deploy

```bash
npm run typecheck
VITE_API_URL=https://api.example.com npm run build    # static files in dist/
```

Serve `dist/` from Caddy on its own subdomain, sending unknown paths to `index.html`. Add that origin to the API's `CORS_ORIGINS`.
