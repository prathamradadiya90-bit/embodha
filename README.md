# Embodha

A Headspace-style wellness app. Members buy courses one at a time or subscribe monthly to an instructor. Instructors publish from a web studio. Admin runs the catalogue, sets each instructor's percentage and pays them at month end.

The product spec is the source of truth: [Embodha: Product & Technical Spec](https://claude.ai/code/artifact/759f9764-5271-4a13-a27f-8b3023a09f0d).

## Where things stand: phase 2, part 2

There are four parts:

- **`apps/mobile`** is the members' app for iOS and Android, built with Expo SDK 58. [Its README](apps/mobile/README.md) covers it in full.
- **`apps/web`** is the instructor studio and the admin panel, one web app for both. [Its README](apps/web/README.md) covers it in full.
- **`apps/api`** is a NestJS 11 API on Postgres, using Drizzle for queries and migrations.
- **`apps/site`** is the public website: the home page, the privacy policy, terms and the other pages the stores and Razorpay ask for. [Its README](apps/site/README.md) covers it in full.

### New in phase 2, part 2: Chromecast

Yoga gets done in front of the TV. A class can now go from the phone to a Chromecast or a Google TV, and the phone becomes the remote.

- **In the app.** Google's Cast button sits by the course name on the player. Pick a TV and the chapter carries on there from where the phone was. The player then shows what the TV is doing and where it's got to, with pause, 15 seconds either way, and "Stop playing on the TV". Next goes to the TV too, as does any chapter opened while connected. Leaving the TV, the phone moves to where the TV got to and waits, paused. On an iPhone, an audio chapter also gets an AirPlay button; videos already have one in their controls.
- **No receiver to register.** The TV runs Google's Default Media Receiver and streams the same signed Bunny link the phone would. Nothing has to be set up with Google, and the token rules are the phone's. A downloaded chapter is cast from the stream. If a TV turns an HLS stream down, the app asks once more saying the segments are fMP4, then says the TV couldn't play it and offers the phone.
- **The TV's time counts.** The phone follows the TV and sends the same heartbeats as its own player, every 30 seconds. It counts how far the TV moved, never more than the clock says passed, and nothing while paused, so skipping ahead isn't practice. A chapter that plays to the end is done, and the course page catches up. Each phone counts only what it sent, so a phone and a tablet on one account don't count a class twice.
- **Locked phones.** Android keeps listening in the background. iOS stops the app, so an iPhone makes up the stretch it slept through when it's opened again, from how far the TV got. If the TV was switched off before that, the stretch isn't counted, and the member's place stays where the phone last saw it. Only a receiver of our own, reporting from the TV, would close that gap; it can wait until the minutes on iPhones matter enough.
- **Beta health** counts the chapters sent to a TV and the ones a TV couldn't play, from two new events, `cast_start` and `cast_error`. Many failures at once usually means Bunny turning TVs away; the Chromecast check below says where to look.
- **The build.** react-native-google-cast 4.9.1, with its config plugin.
  - Android's Cast SDK is pinned to 22.3.1. 23.0.0, out on 19 October, brings in a beta of AndroidX MediaRouter.
  - iOS takes the newest Cast SDK: 4.8.6 at the time of writing, which needs iOS 16 (the app targets 16.4). It also gets the local network question and the Bonjour entries the Cast SDK needs.
  - Make new development builds. One from before this has no Cast SDK, and the app leaves the button out. So does a phone without Google Play services.
- **Also changed:**
  - The audio player's progress bar had been ink on ink since the theme change, so it never showed how far in a chapter was. Now it does.
  - The privacy policy covers TVs: a line under "How the app is used", and what Google's Chromecast software gets under "Who else handles it".

### New in phase 2, part 1: offline downloads

Members can keep chapters on the phone and practise without a connection: on a flight, in the hills, in a basement studio with no signal.

- **In the app.** Each chapter on a course page has a download arrow, and a button under Start downloads the whole course, with its size ("Download all 5 chapters · 501 MB"). Downloads, reached from You and from Library, lists what's on the phone and how much room it takes. It also has the queue, quality (Standard 480p or High 720p), whether mobile data may be used, and the account's phones. The web app streams as before; downloads are for the phone apps.
- **The server says yes to every chapter first.** The course has to be the member's: a free preview of a course they don't have doesn't count. An account's downloads can be on three phones at a time. A fourth phone is told which three, and can take one off the list. The link to the file is signed for that one file and lasts six hours. A paused download asks for a fresh link and carries on from the bytes it has (an iPhone starts it again if the first link has run out).
- **Thirty days offline.** Downloads play for 30 days after the phone was last online. Every check-in starts the 30 days again; the app checks in when it opens and when it reconnects, at most every six hours. A check-in also removes what isn't the member's any more and says why: a refund, a subscription that ran out (its downloads play to the end of the paid month), a chapter taken down. A chapter the teacher uploaded again is fetched again.
- **Practice done offline counts.** Heartbeats wait on the phone, through closing the app, and go up when it reconnects with their own times. The streak and the teacher's minutes land on the day the member practised. And a late heartbeat no longer moves "pick up where you left off" back when the member has since got further on another device.
- **Bunny.** Videos download as the MP4 copies Bunny makes when "MP4 fallback" is on in the library. The API now notes which heights each video has when Bunny says it's finished, and the course page offers a chapter for download only once there's a copy. Bunny makes the copies only for videos uploaded while MP4 fallback is on, so switch it on before uploading. The launch checklist has a new line counting videos without a copy. After re-encoding older ones in Bunny's dashboard, its "Look at Bunny again" button picks them up.
- **The API:** `POST /v1/downloads` (the yes, and the link), `POST /v1/downloads/check`, `GET /v1/downloads/devices` and `DELETE /v1/downloads/devices/:id`. Migration 0013 adds the phones and their chapters, and the MP4 heights on each video. The member's data download includes both lists, and erasing an account erases them.
- **Also changed:**
  - A server error while refreshing the sign-in no longer signs the member out; only a refused token does. Signing out now deletes the downloads, so a hiccup shouldn't cost them.
  - Android backups leave out the app's files. expo-secure-store's backup rules are now set in `app.json`, and they also stop the sign-in being restored to a phone that can't read it. Without them, a few GB of downloads would have stopped Google backing up the app at all.
  - Beta health's video-start bar leaves out chapters played from a download, since the network had no part in how fast they started.
  - The members' web app says it's offline instead of showing a spinner that never stops.
  - The privacy policy has a paragraph on downloads. Set `effectiveDate` in the site's config to the day it goes live.

### Sprint 7, part 4: the launch checklist

Admin has a Launch checklist page: one place that says whether Embodha can launch, and what's in the way. It looks at everything the server can see for itself, says in plain words what it found, and links to where each thing gets put right. There are 35 checks in eight groups:

- **Courses:**
  - the free course is live;
  - every category on show has a course on sale;
  - every chapter of every live course plays. Chapters with no media, still processing, or on the dev seed's stand-in video (which production won't serve) are named.
- **Selling on the website:** live Razorpay keys rather than test-mode ones, and Razorpay's webhook reaching the API.
- **Selling in the apps:**
  - the App Store and Google Play keys;
  - each store's notifications reaching the API. A button asks Apple for a test notification, so the production URL is proved before any real sale;
  - every paid course and switched-on subscription live in both stores;
  - a test purchase from TestFlight and one from a Play licence tester.
- **Money and invoices:** the seller on invoices, the LUT footnote for exports, and the finance inbox.
- **Video, audio and email:**
  - Bunny's keys and webhook, and storage for audio chapters if there are any;
  - sign-in codes going out over SMTP from your own domain, with SPF and DMARC records on it;
  - the App Review sign-in, and the feedback inbox.
- **The website and the sign-in link:**
  - the website's eight pages answer;
  - its refunds page promises the same number of days as the refund window in Money settings;
  - the members' web app serves the two files that make the sign-in email open the app, over https. It recognises the usual mistake: a single-page app's fallback answering for the files.
- **The launch bars** from Beta health, over 14 days. Video start also checks the spec's "three Indian cities, and tested from abroad", by state.
- **Eight sign-offs only a person can give:**
  - the accountant's walk-through;
  - the lawyer's read;
  - enrolment for both stores' 15% rate;
  - the store listings;
  - the device check;
  - a sign-in code reaching Gmail and Outlook inboxes;
  - a restored backup;
  - the penetration test.

  A super admin signs each one off, with a note if they like. The checklist keeps who and when, and so does the audit log.

Every staff role can read the page, and the Overview says how many things are left. Webhooks now note when they arrive (which channel, when, what event), which is how the checklist knows a URL works. The website and DNS are looked at no more than every two minutes; "Check again" looks now.

That's the last of sprint 7's building. What's left is the beta itself, and the checklist tracks it.

### Sprint 7, part 3: reconciliation

Every sale is now checked against what its channel actually paid out, and where the two differ the books take the channel's figure.

- **Razorpay, every night.** After 3 a.m. India time the API asks Razorpay's Settlement Recon API for the last seven days and matches each line: payments with their real fee and the GST on it, refunds, and anything else that moved money, such as adjustments and chargebacks. From admin, finance can fetch any 31 days, or upload the settlement report from Razorpay's dashboard as a CSV.
- **Google Play, once a month.** Upload the earnings report: the CSV from Play Console, or the zip it comes in from Cloud Storage. It's matched order by order: the charge, Google's fee, any tax Google kept, and refunds.
- **The App Store, once a month.** Upload the financial report ("All Countries or Regions", single file). Apple counts units per product and price instead of naming purchases, so each unit goes to the oldest sale in the books with the same product, price and currency. Proceeds paid in dollars wait for the rupee rate Apple paid them at. Finance types it in from that month's payment in App Store Connect.
- **Where a report has the real figure, it replaces the estimate,** and the instructor's share follows it. If the sale is on a statement that's still open, the statement's line changes. If that statement is closed, the difference goes on the next one as an adjustment.
- **A store sale's share waits for its store's report** before it can go on a statement, as the spec's Live earnings section says. Website shares still wait out the refund window.
- **What the books missed gets booked:**
  - a Razorpay payment whose confirmation never arrived, whether a course order or a subscription's renewal, dated the day the buyer paid;
  - a refund made in Razorpay's dashboard;
  - a refund Google made.

  Each one gets its invoice or credit note as usual.
- **Everything else goes under "Needs a look",** with a box for finance to write down what it was: a payment that isn't Embodha's, a chargeback, an adjustment, a store sale that never reached Embodha, or an App Store refund (Apple's report doesn't say whose). When the nightly check finds any, it emails `FINANCE_EMAIL`.
- **Late sales are listed.** Razorpay settles Indian payments in two working days and payments from abroad on a longer cycle, so a website sale shows as late after 4 days, or 11 for dollars. A store sale shows once a report covering its date is in without it.
- **Beta health's reconciliation bar is live:** two weeks of payments matched on all three channels, in rupees and in dollars, with nothing left to look into. App sales count once their store's monthly report is in, so a fortnight in October can only pass after Play's and Apple's reports for it are out, in November. The bar says what's still missing.
- **Payments** says under each sale's net whether it matches the channel's report yet, or the fee is still an estimate.

Two corrections to the arithmetic came with it:
- **Razorpay's fee is booked without the GST on it.** That 18% comes back as input credit, so it isn't a cost the instructor should share. On a ₹999 card sale the fee is ₹19.98 rather than ₹23.58, and a 60% share is ₹2.16 more.
- **A website sale in dollars is booked at Razorpay's own conversion,** which the payment carries, rather than the ₹88 setting.

**When this goes live,** every website sale of the beta so far is still booked the old way: card fees with Razorpay's GST in them, and dollars at ₹88. Fetch Razorpay's settlements once from the first beta payment, 31 days at a time, and each of those sales is corrected to its real fee. Shares on a closed statement get the difference on the next one. Store sales already booked hold their shares back until their store's report is uploaded; the migration does that for every share not yet on a statement.

### Sprint 7, part 2: hearing from the beta

This part tells the team how the beta is going, from Embodha's own server rather than an outside service.

- **Crash and error reports** from the apps (`POST /v1/app-errors`):
  - A crash is saved on the phone the moment it happens and sent on the next launch.
  - A screen that fails to draw now shows "This screen didn't load", with Try again and Go to Today, instead of a blank page, and is reported as a crash.
  - Other errors nobody caught go up a few seconds later, each different one once per launch.
  - The same problem from different phones and builds is grouped by a fingerprint: the message with its numbers and IDs taken out, plus the function at the top of the stack.
  - Email addresses are taken out of messages before they're stored, and reports are deleted after 90 days.
- **How long chapters take to start:** from opening the player to the first frame, or the first sound of an audio chapter. Each start goes with its connection (Wi-Fi, or mobile data and whether it's 4G or 5G) and the part spent asking the server for the stream.
- **Feedback** from You, Feedback in the app (`POST /v1/feedback`). It carries the app version and phone model, lands on a new admin page, and goes to `FEEDBACK_EMAIL` if that's set, with the member's address to reply to.
- **Beta health in admin** shows the spec's launch bars against their targets, and holds each verdict until there's enough data:
  - crash-free sessions: 99.5%, judged from 100 sessions;
  - video start on 4G: 9 in 10 within 2 seconds, judged from 30 starts;
  - nobody charged after a teacher switches their subscription off: every switch-off so far, with the renewals that fell due since and any charge that came anyway, test purchases included;
  - reconciliation, which arrived in part 3.
- **"Share how you use the app"** now also covers crash reports and start times, and the privacy policy says so. Feedback and crash reports are in the member's data download.
- **The teacher's switch** is now in the audit log, which is how Beta health finds switch-offs.

### Sprint 7, part 1: builds for the beta

Sprint 7 gets Embodha through the closed beta in the spec: 50 to 100 members and every instructor, then the stores. This part makes the builds.

- **EAS build profiles** (`apps/mobile/eas.json`):
  - `preview` is for the team's own phones.
  - `production` is for TestFlight, Play's testing tracks and release. Its build numbers go up by themselves.
  - `eas submit --profile beta` sends iOS builds to TestFlight and Android builds to Play's internal testing track.
- **A store build checks itself** (`apps/mobile/app.config.ts`):
  - It refuses to build without the API, the website and the domain the one-tap sign-in link opens. Those live in EAS's environment, not the code.
  - It sets up universal links and Android app links on `/auth/link`, so the sign-in email opens the app.
  - It declares "no special encryption", so App Store Connect stops asking about export compliance.
  - It carries Apple's privacy manifest, with the reasons for the system APIs the app's libraries use.
  - It drops three Android permissions the app never uses.
- **The members' web app vouches for the app:** `npm run web:release` writes the two `.well-known` files that iOS and Android check before opening a link in the app.
- **Light mode on Android:** added `expo-system-ui`, which Android needs to keep the app light when the phone is in dark mode.

[The app's README](apps/mobile/README.md#builds-for-the-beta-and-the-stores) has the one-time setup, the commands, and what to expect from TestFlight and Play testing.

### Sprint 6, part 5: GST split on invoices

- **Every website invoice now shows its GST the way the law reads.**
  - A buyer in the seller's state pays CGST and SGST, each at 9% (UTGST instead of SGST if the seller is in a union territory without a legislature).
  - A buyer in any other state pays IGST at 18%.
  - A buyer abroad pays nothing: the sale is an export, place of supply 96, and the invoice carries the LUT footnote from Money settings.
  - Each invoice also shows the place of supply, the SAC if one is set, and "reverse charge: no".
- **Where the buyer is.**
  - Members in India pick their state at sign-up, by typing a few letters.
  - Members in India who signed up before this see a "One more step" card on Today until they pick one.
  - "Your details" under You changes it, along with name, country and year of birth.
  - Website checkout in India won't go ahead without a state. CBIC circular 242/36/2024-GST makes it compulsory on every invoice for an online service, so the app sends the member to "Your details" first.
  - A renewal for someone who never gave a state can't be refused. It's taxed in the seller's state and flagged on the GST page.
  - The seller's state comes from its GSTIN. Money settings checks the GSTIN's check digit, so a typo is caught before it reaches an invoice.
- **Invoices don't change after they're issued.** Each sale keeps the rate, the split, the place of supply, the seller's details and the footnote it was booked with. Changing Money settings later only affects new sales. App Store and Google Play sales are left out: the store is the seller there.
- **Refunds get a credit note:** numbered CN/26-27/000001 and up, mirroring the invoice's split, emailed to the member and downloadable from Payments.
- **Numbers that pass GSTR-1.**
  - Invoice numbers are now EMB/26-27/000001: 16 characters, the most GST allows. The old EMB/2026-27/… form was 18.
  - Each series starts again every April.
  - A number is taken inside the transaction that books the sale, so a payment that fails, or the webhook and the app arriving together, never leaves a gap.
- **A GST page in admin, for finance.** For any month it shows:
  - sales in India by place of supply, with CGST, SGST and IGST;
  - credit notes taken off in the month they're issued;
  - exports, converted to rupees at the rate they were booked at;
  - the first and last number of each series.

  It downloads two CSVs: a summary by state, which is what GSTR-1's tables 7 and 6A and GSTR-3B need, and a line-by-line register.

### Sprint 6, part 4: the public website

- **Nine plain pages:** home, pricing, privacy policy, terms of use, refunds and cancellations, shipping and delivery, deleting your account, help and contact, and a "not found" page. They're in the app's look, with the same paper, ink and typefaces.
  - There are no scripts, cookies or analytics, and nothing loads from another site.
  - **What each page answers:**
    - **Apple:** a privacy policy, a support page, and terms next to subscriptions.
    - **Google:** a privacy policy and an account deletion page.
    - **Razorpay:** terms, privacy, refunds, shipping, pricing and contact pages before it turns on live payments.
    - **India's e-commerce rules:** the company's details, a customer-care number, and a Grievance Officer who answers within a set time.
- **Written from what the system does.** The privacy policy lists what's stored, the app events and how to switch them off, and the companies that handle data (Bunny, Razorpay, Apple and Google, Expo, the email service, hosting). It also covers how long each thing is kept and what deleting an account erases after 30 days. It says what's kept for the tax records, as an empty account with no name or email.
  - The refund page matches the refund window in Money settings. It also sends App Store and Google Play refunds to Apple and Google.
- **Business details live in `apps/site/site.config.json`:** the company name, address, Grievance Officer and so on.
  - A preview build highlights anything missing in yellow.
  - `npm run build:release` refuses to build until it's all there.
- **The app links to the website.** These links appear only once `EXPO_PUBLIC_SITE_URL` is set for the build:
  - **You** has "Privacy policy · Terms of use · Help".
  - **Sign-in** says that continuing means agreeing to the terms and the privacy policy.
  - **Every subscription offer** has the terms and the privacy policy underneath, as Apple requires.

### Sprint 6, part 3: a photo and a video of the day

- **The Today screen has room for three things a day:** the line it already had, a photo, and a short video. Each is optional, and members see the ones for their own date.
  - The photo sits under the line with its caption and who took it, at its own shape, so the screen doesn't jump as it loads.
  - The video shows as a still with a play button. Nothing downloads until someone taps it. It's free to everyone, like a preview chapter.
- **Admin's "Today screen" page** (it was "Quote of the day") sets all three, two weeks ahead.
  - A photo goes through the API. ffmpeg checks it really is a JPEG, PNG or WebP, shrinks it to 1,600 px wide and saves it again. That removes the location and camera details phones write into photos, before it reaches Bunny Storage.
  - A video goes straight from the browser to Bunny, like a chapter. The page shows "Getting ready" until Bunny has made its streaming versions, and it reaches the app only then.
- **Older app versions** still get the quote exactly as before.

### Sprint 6, part 2: changing a live course

- **Instructors can now edit a live course.** They use the same studio screens as a draft, but the edits go into a copy. Members keep seeing the course as it was until the Embodha team approves the changes.
  - What can change: the details (title, description, level, language, equipment, cautions), chapter titles, notes and free previews, the chapter order, new chapters, and a new video or audio track for any chapter.
  - What can't: a live chapter can't be removed, because members may have bought the course for it. The price and the course's address stay as they are; a price change goes through the Embodha team.
  - When they're done, "Send changes for review". Until admin answers they can take the changes back to keep editing, or discard them.
- **Admin reviews a plain list of what changed.** Each change shows what it was and what it would be: a new title, a renamed chapter, a new video, a chapter made free to preview, the new order.
  - "Approve and go live" applies everything in one go.
  - "Send back" needs a note. The instructor's copy stays as it was, so they carry on from where they left off.
  - Waiting changes are at the top of Courses and in the Overview queue, tagged "Changes".
- **A gap closed.** Until now, a live course's chapters could be changed directly through the API, though the studio didn't offer it, so members would have seen edits straight away. Now every change to a live course goes through the copy, and a course waiting for its first review can't be edited at all.

### Sprint 6, part 1: reminders, scheduled messages, quiet hours

- **Daily reminder.** Under You, members pick a time (or Off). At that time on their own clock the phone gets a nudge, but only on days they haven't practised yet.
  - Someone partway through a course is pointed back to it; everyone else gets today's breath. The breath wording changes from day to day.
  - Turning a reminder on is when the app asks for notification permission.
  - If the server was down and a reminder is more than two hours late, it's skipped rather than sent at an odd hour.
- **Scheduled messages.** Notifications in admin can go now or at a set time, in Indian time, up to 60 days ahead. A scheduled one goes to whoever matches the audience when it's sent, and can be cancelled until then.
- **Quiet hours.** From 10 pm to 8 am on a member's clock, a message from Embodha goes to their bell straight away, but the phone push waits until 8 am. If they've read it in the app by then, the push isn't sent at all. Admin shows how many waited.
- **How it runs.** One job, once a minute, sends what's due: scheduled messages, pushes held overnight and reminders. Each send is claimed in the database first, so two servers never send the same thing twice. Reminder history is in the member's data download.

### Sprint 5, part 2: analytics, and deleted accounts that really go

**Analytics**
- **Events from the app.** The app sends a few named moments to Embodha's own API in small batches. No outside tracker is involved.
  - What it records: the app opening, screens, a course page, a locked chapter, a purchase started, finished or given up on, a breath begun.
  - IDs and screen names only, never anything typed. The API drops names it doesn't know and anything that isn't a short label.
  - Each install makes a random ID, so guests can be counted without knowing who they are. Signing out makes a new one, so a shared phone doesn't blur two people.
  - Batches go every 15 seconds, at 20 events, and when the app is put away. Offline, the newest 200 wait.
  - Under You, "Share how you use the app" turns it off for that phone.
- **Analytics in admin** (finance and content), for the last 7, 30 or 90 days:
  - Active members today, this week and this month, and stickiness: an average day's members as a share of the month's.
  - Members and guests each day, as a chart you can hover or read with the arrow keys, or as a table.
  - Joined, then practised: the share who played a chapter or finished a breath in their first week.
  - Course page to purchase, overall and per course, and what happens after a locked chapter.
  - Coming back in the first week, by the week people joined.
  - The most practised courses, and teachers by minutes and earnings.
- **How it's counted.** Days are Indian days. Staff accounts and store test purchases are left out. A guest who signs in later counts once, as the member.
- **It stays quick.** As events, heartbeats and breaths arrive, the API also keeps one row per member per day and one per install per day, and the report reads those. Against 50,000 members, 3 million events and 2 million heartbeats it answers in 1 to 3 seconds; reading the raw tables took up to 15.

**Deleted accounts**
- **A gap from earlier sprints:** nothing actually erased an account after its 30 days, though the app says it will. Now a job does, every hour.
  - Without purchases, the account and everything tied to it is deleted. App events stay, with no link to the person.
  - With purchases, the payments are kept, because invoices must be (GST law asks for six years). The account row stays as an empty shell for them to point to: no email, name or details, and none of the practice, notes, reviews or library.
  - Course ratings are worked out again without the erased reviews.
- **Deleting an account now stops renewals.** Razorpay and Google Play subscriptions stop straight away, and the month already paid runs out. Only the member can cancel an App Store subscription, so the app tells them how.
- **Admin** marks erased accounts, and won't restore one or add a course to it.

**Also**
- On a phone-width screen, admin pages with wide tables (Payments, for one) scrolled sideways as a whole. Now the table scrolls in its own frame.
- **For the store listings,** declare the analytics as first-party:
  - App Store privacy: Usage Data, Product Interaction, linked to the user, used for analytics, not for tracking.
  - Play Data safety: App activity, App interactions, collected, not shared, optional.
  - The privacy policy (sprint 6) should say the same.

### Sprint 5, part 1: security, your data, low-end phones

- **Security review.** [SECURITY.md](SECURITY.md) lists what was checked, what was fixed and what's left for people to do before launch. The fixes:
  - Uploaded audio can no longer make ffmpeg read other files or fetch URLs.
  - Staff sessions end after 12 hours without use; members' still last 60 days.
  - The studio and admin page carries a Content Security Policy.
  - App Store and Google Play purchase checks have their own rate limit.
  - Production refuses http origins.
  - A moderate js-yaml advisory is pinned shut.
- **Your data.** Under You, "Email it" sends the member a JSON file of everything Embodha holds about them, as DPDP and GDPR ask.
  - It includes their account, practice, purchases, subscriptions, decrypted notes, reviews, searches and notifications.
  - It leaves out the server's own secrets, like the hashes of sign-in tokens and push addresses.
  - Three a day per member, recorded in the audit log. The inbox is the proof that the person asking is the account holder.
- **Low-end Android.** These are the changes that can be made without a device; the rest needs measuring on a cheap phone (see "Device check" below).
  - Course covers load through expo-image, which caches them and decodes them at the size shown.
  - Video starts after 1.5 seconds of buffer instead of Android's default, and doesn't hold more than 20 seconds ahead.
  - Release builds are shrunk (R8 minify and resource shrinking).
  - Course cards don't re-render unless their course changes, and rails drop off-screen cards.

### Sprint 4, part 4: the server makes the store products

Nobody has to type product IDs and prices into App Store Connect and Play Console any more. With the keys set (see "Store check"), the server does it.
- **A course,** once published and paid, gets a non-consumable in-app purchase on the App Store and a one-time product on Google Play.
  - Both are priced from the catalogue: rupees in India and dollars in the US.
  - Everywhere else gets the stores' own equivalents of the dollar price.
  - Apple gets the review screenshot (the course screen, in `apps/api/assets/`) and the request for review.
- **A teacher's subscription,** once switched on, gets an auto-renewing subscription in the teacher's own App Store group and a monthly base plan on Google Play.
  - A new price in the studio is passed on. Apple keeps current subscribers on the price they joined at, so nobody has to agree to a rise.
- **Off sale.** Archiving a course takes it off sale in both stores, and so does making it the free course.
  - Switching a subscription off takes it off sale too, which closes the gap left in part 3: App Store subscribers now stop at their next renewal date. The studio says so.
- **Safe to repeat.** Each step that's done is written down, so a run that fails picks up where it stopped.
  - Every half hour the server retries anything that failed, backing off as failures repeat.
  - The same sweep checks on Apple's review and marks products live when they're approved.
  - It also makes products for anything already on sale that has none, such as courses published before the keys were set.
- **Store products page.** It shows which products the server made and where each stands in its store. A button makes or retries one now, and the page updates while it works.
  - Products linked by hand are left alone; editing one by hand takes it over from the server.
- **One thing stays manual.** Apple only accepts an app's first products alongside a new app version. The page says when a product is waiting for that.

### Sprint 4, part 3: buying in the iOS and Android apps

Apple and Google require their own billing for anything digital sold inside an app. So in the phone apps, courses and teachers' subscriptions are now bought through the App Store and Google Play. The web build keeps Razorpay.

- **Checked with the store, every time.** The app sends each purchase to the API, which asks Apple or Google about it before anything unlocks. Pushed notifications are treated the same way: the API reads which purchase they're about, then asks the store directly. A forged notification can't unlock or refund anything.
- **One purchase, one account.** The app tags every purchase with the member's Embodha ID, and the API refuses a purchase that belongs to another account. Restore purchases, under You, brings earlier purchases back on a new phone.
- **Booked like any other sale.** GST comes out for sales in India, then the store's commission (15% of the price before GST, set in Money settings), then the split at the instructor's share. This is the spec's worked example: ₹999 leaves ₹719.62, and the instructor gets ₹431.77 at 60%. Apple and Google are the seller on these sales and send the member their own receipt, so there's no Embodha invoice.
- **Renewals, lapses and refunds** arrive as App Store Server Notifications and Google Play's real-time notifications. Each one updates the member's access and the books. A refund made by Apple or Google reverses the instructor's share, the same as a Razorpay refund. If the share was already paid out, it comes off their next payout.
- **Payments that clear later** (Ask to Buy, a cash payment on Play) unlock once they clear. A Play purchase is acknowledged as soon as it's recorded, because Play refunds any purchase that isn't acknowledged within three days.
- **Test purchases** from App Review, TestFlight sandbox accounts and Play licence testers unlock for real. They carry no invoice and no split, and they're marked on Payments and left out of its totals.
- **Store products** (admin: content and finance). Each paid course and each teacher's subscription is linked to its product ID in each store, with a status: setting up, in review, live, or a problem with a note. A buy button appears in the app once a product is in review or live. (Part 4 has the server make them.)
- **Switching a subscription off** in the studio now stops Google Play renewals too, through Play's API. Apple doesn't let anyone else cancel a member's subscription, so App Store subscribers keep renewing until the product is taken off sale in App Store Connect. The studio says how many that is.

### Sprint 4, part 2: subscriptions, invoices, money settings

- **Instructor subscriptions.** On the web, members subscribe to an instructor through Razorpay and every course of theirs unlocks.
  - Each charge, the first and every renewal, is booked like a course sale: invoice, GST, fee, and the split at the instructor's share.
  - Renewals arrive by webhook and move the paid-up date forward.
  - Members can stop renewing from Library, and keep everything until the end of the month they've paid for.
  - When an instructor switches their subscription off in the studio, every renewal stops the same way.
  - Razorpay plans are made automatically, one per instructor, price and currency.
- **Invoices.** Every payment gets a one-page PDF invoice, emailed to the member as it's recorded.
  - It can also be downloaded: the member gets their own, and finance and support can get any of them from Payments.
  - India: a tax invoice showing the GST inside the price.
  - Abroad: an invoice with the footnote set in Money settings.
- **Money settings** (finance). One page holds:
  - the dollar rate, the refund window, the minimum payout and the default share;
  - the seller's legal name, address and GSTIN for invoices, and the invoice footnotes.

  Each instructor's TDS rate is set on the Instructors page.

### Sprint 4, part 1: selling courses

- **Checkout.** Members buy a course through Razorpay Checkout: in rupees with GST included for members in India, in dollars for everyone else. The API opens the order at the member's price. It only unlocks the course once Razorpay's signature checks out and the payment is confirmed as captured.
- **Recorded once.** A payment is recorded exactly once, by whichever arrives first: the app's confirmation, or Razorpay's webhook if the member closed the app mid-payment. Each payment gets an invoice number for the financial year, now `EMB/26-27/000001` (see sprint 6, part 5).
- **The split.** Each sale is split as the spec describes: price, minus GST, minus Razorpay's actual fee, then the instructor's share at that moment and Embodha's at the rest.
  - Dollar sales use an estimated 3.54% fee, and convert to rupees at `usd_inr_rate` in settings.
  - A share becomes payable after the 7-day refund window.
- **Refunds** (admin, finance role). Full refunds through Razorpay; refunds made in the Razorpay dashboard arrive by webhook and are handled the same way. The course leaves the member's library and the instructor's share is reversed. If that share was already paid out, it comes off their next payout.
- **Payouts** (admin, finance role). Once a month has ended, prepare its statement, close it, pay each instructor by bank transfer, and record the reference.
  - Small balances (under ₹500) roll over to the next month, and TDS is taken at each instructor's rate.
  - A CSV is available for the bank.
- **Where people see it.** Instructors see earnings, sales and payouts in the studio. Members see their purchases and invoice numbers under You.
- **Phones.** Buying in the iOS and Android apps came in part 3, through the stores' own billing.

### Sprint 3, part 2

**In the app**
- **Search:** from Explore, across course titles, descriptions, topics and teacher names.
- **Reviews:** stars and a few words, from members who have played the course.
- **Private notes:** written under the player and pinned to the moment, encrypted in the database (AES-256-GCM).
- **Notifications:** the bell on Today with its history, and push to phones. The app asks once after sign-up, there's a switch under You, and the phone is forgotten on sign-out. Tapping a notification opens the screen it points to.
- **Gender:** asked (optionally) during onboarding, so admin can send campaigns by sex.

**Studio and admin**
- **Audio chapters (studio):** the API runs each file through ffmpeg to even out loudness (EBU R128, -16 LUFS), stores it as AAC on Bunny Storage, and serves it on signed URLs.
- **Reviews (admin):** read, hide, reply as Embodha, or delete.
- **Notifications (admin):** a message to everyone, or filtered by gender, age range or country, with a live count of who it reaches. Sent messages are listed with how many people read them.
- **Quote of the day (admin):** two weeks ahead.

### Sprint 3, part 1

**Studio, for instructors**
- **Courses.** Create a draft, fill in its details and price, then add, reorder and remove chapters, with any chapter marked as a free preview.
- **Uploads.** Video goes straight from the browser to Bunny and resumes after a dropped connection or a reload.
- **Review.** Send a course for review. If admin sends it back, their note shows on the course.
- **Subscription.** Switch the monthly subscription on or off and set its price.
- **This month.** Minutes watched.

**Admin, for staff**
- **Courses.** A review queue: publish, or send back with a note. Also pick the free course and archive.
- **Instructors.** Add by email, set each share % (the change counts from now on), suspend.
- **Members.** Search, suspend or restore, delete with a 30-day grace, and add a course to someone's library, which the app's checkout message already promises.
- **Catalogue.** Categories and topics; new categories start hidden.
- **Reports.** Minutes watched per instructor per month, with CSV download.

Access depends on role: content, finance, support or super admin. The API checks it on every request, and every change goes in the audit log.

**API:** `/v1/admin/*` and the new studio routes behind the screens above. When an upload hasn't finished, the API hands out the same video again, so the browser can resume it.

### Sprint 2

**The app**
- **Screens.** Today, Explore, topic and course pages, the Library and You.
- **Breathing.** The breathing screen, with a breath on the first open of each day.
- **Sign-in.** Email code or one-tap link, then the details screen.
- **Player.** Video and audio player that resumes where you left off and offers the next chapter, plus a locked screen showing the ways to unlock.
- **Guests.** Guests can breathe, take the free course and play previews.

**The API**
- **Practice.** Breathing sessions and member stats: a streak in the member's own time zone, and minutes practised. Playback heartbeats feed resume, "pick up where you left off", completion at 95%, and daily watch time per instructor, which feeds the instructors' reports. (Subscriptions are per instructor, so watch time never decides who gets paid.)
- **Catalogue.** The home screen comes in one call. The library lists bought, started and subscribed courses. Topics carry course counts. Playback now returns the chapter and course titles and the next chapter.
- **Dev data.** The dev seed gives every chapter a length and a public sample stream, and adds two weeks of quotes, so the app works locally without a Bunny account. Production never serves the sample stream.

### Already in place from sprint 1

- **Sign-in.** Email plus a six-digit code, or the one-tap link in the same email.
  - Each code lasts 10 minutes and gets five tries.
  - Each address can ask for five codes an hour.
  - Access tokens last 15 minutes. Refresh tokens rotate on every use, and replaying an old one ends the session.
  - A fixed-code account is ready for App Review.
- **Account.** Details are asked after sign-up, with an 18+ check. Deleting an account starts a 30-day grace period.
- **Catalogue and access.** Prices are in INR (GST included) or USD. `AccessService` holds every rule: the free course, preview chapters, bought or granted courses, live instructor subscriptions, and an instructor's own courses.
- **Playback.** Signed Bunny HLS URLs. A locked chapter returns 402 with everything the unlock screen needs.
- **Studio API.** Courses, chapters, the preview toggle, and resumable uploads that go straight to Bunny, with a verified webhook.
- **Money.** `computeSplit` reproduces the spec's worked example to the paisa. Every table the spec lists already exists.

### Not built yet

- **Store prices in other currencies:** set from the stores' conversions of the dollar price; local pricing beyond India and the US waits for the client's call

## Run it

[LOCAL-SETUP.md](LOCAL-SETUP.md) walks through it step by step for Windows, macOS and Linux, with phones and troubleshooting. The short version, each part in its own terminal:

```bash
docker compose up -d db

cd apps/api
cp .env.example .env        # set JWT_SECRET and CODE_SECRET: openssl rand -base64 48
npm ci
npm run db:migrate
npm run db:seed:dev
npm run dev                 # http://localhost:3000, docs at /docs

cd apps/mobile
cp .env.example .env        # EXPO_PUBLIC_API_URL; on a phone, your computer's LAN address
npm ci
npx expo start --web        # http://localhost:8081

cd apps/web
cp .env.example .env        # VITE_API_URL
npm ci
npm run dev                 # http://localhost:5173
```

To sign in, use one of the dev accounts below, or any new address to see sign-up. Mail goes to the console in development, so the code prints in the API's log.

- `member@embodha.local`: member
- `asha@embodha.local`: instructor, on 60% with a monthly subscription switched on
- `admin@embodha.local`: super admin

The dev courses are *Morning Breath, 5 Days*, which is the free course, and *7-Day Gentle Spine*, at ₹999 / $12 with a free first chapter.

The public website is plain files: `cd apps/site && npm ci && npm run build`, then serve `apps/site/dist` with any static server (`npx serve dist -l 8090`). To see the app's links to it, set `EXPO_PUBLIC_SITE_URL` in `apps/mobile/.env` to wherever it's served.

## Tests

```bash
cd apps/api && npm run typecheck && npm test    # 182 tests; the audio and photo ones need ffmpeg installed
cd apps/mobile && npm run typecheck && npm test && npm run web:build    # 62 tests
cd apps/web && npm run typecheck && npm run build
cd apps/site && npm test && npm run build    # 5 tests
```

The API's end-to-end suites boot the whole app against an in-memory Postgres (PGlite), so they don't need a database. CI runs each part's checks on every push that touches it.

For this sprint the web build was also walked through in Chromium against the API on Postgres 16. The walk covered:
- **As a guest:** breath on launch, browsing, the preview, and the locked screen.
- **Account:** sign-up and the details screen, then later sign-out and the one-tap link.
- **Playing:** a video chapter and an audio chapter, with the heartbeats landing in the database and "pick up where you left off" appearing.
- **Practice:** a full breathing session that started the streak.

Screens from that run are in `docs/screens/`.

For sprint 3, the studio and admin were walked through in Chromium against the same setup:
- **As admin:** added an instructor at 65%, opened the catalogue, and added a course to a member's library.
- **As the instructor:** created a course, set its price and details, and added a chapter. The upload was refused cleanly because there are no Bunny keys locally. A ready video was then stood in for Bunny, and the course was sent for review.
- **As admin again:** published it from the review queue.

Those screens are in `docs/screens/web/`.

For sprint 3 part 2, one more walk:
- **Admin:** sent a notification and set the quote.
- **A member:** saw the unread bell and the quote on Today, searched for "spine", wrote a note during a chapter, and reviewed the course.
- **Admin again:** replied to the review.

Those screens are in `docs/screens/sprint-3b/`.

For sprint 4 part 1, a purchase was walked from start to finish against a stand-in for Razorpay's API. The checkout signature, recording and split were all the real code.
- **The member** bought 7-Day Gentle Spine in the app's web build and saw it unlock, with the invoice number under Purchases.
- **Admin** saw the sale, prepared the month's statement, closed it and recorded a bank reference.
- **The instructor's** studio showed the sale and the payout.

Those screens are in `docs/screens/sprint-4a/`.

For sprint 4 part 2, against the same stand-in:
- **The member** subscribed to Asha Rao, saw her paid course unlock, then stopped renewing from Library.
- **Admin** filled in the invoice details and checked the charge on Payments.
- **The invoice:** the subscription's PDF was rendered to check its layout. It's `docs/screens/sprint-4b/invoice.png`.

Sprint 4 part 3 can't be walked end to end here, because a real purchase needs a phone signed in to a store. What was checked instead:
- **The API's store suite.** Apple's and Google's servers are faked at the edge, and everything after that is the real code: checks, ownership, booking, renewals, cancellation, expiry, pending payments, refunds, test purchases, and switching a subscription off. Separate tests check the signed tokens both stores require, using real keys made for the test.
- **The app's purchase flow** (`npm test` in `apps/mobile`), with the stores played by test code, on iOS and on Android.
- **Bundles.** The iOS and Android JavaScript bundles build with the store code in them, and the web bundle builds without it.
- **Part 4,** in the same way: both stores' management APIs faked at the edge, and the rest real. The Store products page was also walked with dummy keys, so the server really tried both stores and showed why it couldn't reach them (`docs/screens/sprint-4d/`). The tests cover publishing, a failed step and its retry, Apple's approval, the first-product rule, and a teacher's subscription switched on, re-priced and off. Separate tests check the calls themselves: the team key's token, the nearest price points, the screenshot upload, and Play's product formats.
- **A browser walk of admin.** Linked a course and a subscription on Store products, including a clash of IDs and a product with a problem. Then checked the commission in Money settings, and how Payments shows App Store sales and test purchases. Those screens are in `docs/screens/sprint-4c/`.

For sprint 5 part 2:
- **The API suites** cover the events coming in, the report's numbers on a small known set of people (who's active, guests who sign in later, staff and test purchases left out, the first-week table), the daily rows, erasure both ways, and renewals stopping when an account is deleted.
- **The app's event queue** (`npm test` in `apps/mobile`): batching, the offline cap, the switch, and a new ID after signing out.
- **In Chromium:** the members' web build sent real events as a guest and as a member, and got a new ID after signing out. The Analytics page was walked on three months of made-up use: at 7, 30 and 90 days, at phone width, with the keyboard and as a table. Those screens are in `docs/screens/sprint-5b/`.
- **A load check** on a copy with 50,000 members (the numbers are above).

For sprint 6 part 1, the API suite runs the once-a-minute job against a set clock. It covers reminders across time zones, members who'd practised, a learner pointed back to their course, the two-hour cut-off, a scheduled message with pushes held to 8 am and dropped for someone who'd read it, and cancelling. In Chromium, a message was scheduled in admin and a reminder time set and cleared in the members' web build (`docs/screens/sprint-6a/`).

For sprint 6 part 2, the API suite covers editing a live course while members still see the old one. It checks the copy's chapters, the refusals (removing a live chapter, changing the price, editing while with admin or before the first review), admin's list of changes, sending back with the work kept, approval applied in one go, and discarding. In Chromium the whole loop ran against the dev course (`docs/screens/sprint-6b/`): Asha edited it and admin approved, and the members' course changed only at that moment.

For sprint 6 part 3, the API suite uploads a real PNG and checks it comes out a 1,600 px JPEG, and that a text file named like a photo is refused. It also checks the video ticket, that the video stays off the app until Bunny has finished it, and that removing one item leaves the others. In Chromium the Today screen showed the photo and played the video on a tap, and the admin page listed both (`docs/screens/sprint-6c/`).

For sprint 6 part 4, the site's tests build it with sample details. They check:
- every detail is filled in, and every link and `#section` resolves;
- nothing is a script or loads from elsewhere;
- a release build stops on a missing detail.

In Chromium, every page was opened at desktop and phone width with no overflow and no outside requests. In the members' web build, each link opened the right page: from You (as a guest and as a member), from sign-in, from the subscription offer and from the locked chapter. The screens are in `docs/screens/sprint-6d/`.

For sprint 6 part 5:
- **The API suites** cover:
  - the split itself: same state, another state, an export, an odd paisa, no GSTIN yet, and UTGST;
  - checkout refusing a buyer in India with no state, and a renewal for one falling back and being flagged;
  - the GSTIN check digit against the GST Network's own example;
  - numbers that don't skip when a payment is confirmed twice;
  - invoices that keep their seller after Money settings change;
  - a refund's credit note and its email;
  - the month's report, line by line.
- **The app's tests** check the state search, and that its list of states matches the API's code for code.
- **In Chromium, on Postgres 16 with a Razorpay stand-in,** it ran in this order:
  1. Finance's GSTIN typo was caught.
  2. A new member in Karnataka picked her state and bought a course (CGST and SGST), then moved to Maharashtra under "Your details".
  3. A member in Maharashtra subscribed (IGST) and was refunded (a credit note by email).
  4. A buyer in the UK paid in dollars (an export).
  5. The GST page and both CSVs added up.

  The screens and the PDFs are in `docs/screens/sprint-6e/`.

For sprint 7 part 1:
- **The app's tests** check the build settings and the sign-in link files.
- **`expo prebuild`** ran in a scratch copy with store settings:
  - the iOS entitlements carry the associated domain;
  - Info.plist declares no special encryption;
  - the privacy manifest lists the reasons;
  - Android's manifest has the verified link and drops the three permissions;
  - light mode is set on both.
- **The iOS and Android bundles** built, and the web app's link files were served as JSON through the Caddy block.

For sprint 7 part 2:
- **The API suites** cover:
  - reports from guests and members, grouped across builds, with an email address taken out;
  - crash-free sessions by platform and version, held until there are 100, and a 7-day window;
  - start times at the 90th percentile on 4G, with a slow give-up counted and a quick one not, and the web kept apart;
  - a switch-off with renewals due, then a sandbox charge after it, then the plan switched back on;
  - feedback to the page and the inbox, handled and reopened, and in the member's data download;
  - reports deleted after 90 days.
- **The app's tests** run the crash reporting with the phone and the browser played by test code, and the start clock.
- **The iOS and Android bundles** built with the file-based crash store and NetInfo in them.
- **In Chromium, on Postgres 16:** two weeks of a 26-phone beta were sent through the real endpoints, then:
  1. A member wrote to the team from You, and the email reached the inbox with her address to reply to.
  2. She played a chapter, and its start time arrived.
  3. A course page the app couldn't draw showed "This screen didn't load" and arrived as a crash. So did an error nobody caught.
  4. Admin read Beta health at 14 and 7 days (and at phone width), then the Feedback page, and marked one handled.

  The screens are in `docs/screens/sprint-7b/`.

For sprint 7 part 3:
- **The API suites** cover:
  - Razorpay's settlements: a fee that matches, an estimate corrected, dollars at Razorpay's rate, a lost payment and a lost renewal booked, someone else's payment, an adjustment, a refund, the same days fetched twice, and writing down what a line was;
  - a corrected share moving its line on an open statement, then going on the next statement once that one is closed;
  - Play's report: Google keeping the GST and passing it on, dollars at Google's rate, a refund the books missed, a sale that never arrived, shares becoming payable, the same file twice, and a file that isn't a report;
  - Apple's report: units to the oldest sales, a sale after the fiscal month left for the next report, a refund the books don't have, and dollars once the rate is in;
  - the nightly check: not before 3 a.m., once a day, and the email to finance;
  - who can see it, and the Beta health bar;
  - the report readers on their own: zip, gzip and UTF-16 files, CSV and tab-separated, a header with a title above it, a comma nobody quoted, and amounts and dates in each report's format.
- **The upgrade on Postgres 16:** part 2's sales went in at migration 0010, then 0011 ran. Their fees stayed estimates for the first settlement to correct, rupee amounts were filled in, store sales got their product from Store products, and store shares not yet on a statement were set to wait for their report. One already on September's statement was left alone.
- **In Chromium, on Postgres 16 with a Razorpay stand-in:** six weeks of beta money were laid down first. That was 13 website sales from 10 to 21 October through the real checkout, and 14 App Store and Google Play sales from September and October, booked the way the store flows book them. Sales up to the 14th were put back the way part 2 booked them. Then:
  1. The nightly check ran by itself, five minutes after the API started. It matched 15–21 October, booked a UPI payment whose confirmation never came, and emailed finance about a workshop payment and a chargeback.
  2. Finance fetched from 9 October. The first week's card fees were corrected and their shares went up.
  3. Finance wrote down what the workshop payment and the chargeback were.
  4. In September, finance uploaded Play's earnings report and Apple's financial report, typed in Apple's dollar rate, and wrote down a Play sale that never arrived and a refund Apple made.
  5. Payments, Beta health and Asha's studio showed where each sale stands, and when her share of an app sale becomes payable.

  The screens are in `docs/screens/sprint-7c/`.

For sprint 7 part 4:
- **The API suite** takes the test fixtures from "not ready" to "ready to launch":
  - live keys, a mail domain with SPF and DMARC records (the DNS answers are stubbed);
  - each channel's webhook through its real endpoint, while a caller without the secret doesn't count;
  - store products, a test purchase from each store, and Money settings;
  - a local web server standing in for the website and for the web app's link files;
  - the sign-offs, and the launch bars, stubbed as met.

  It also covers the refunds page disagreeing with Money settings, a link file that redirects, one caught by a single-page app's fallback, Apple's test notification (asked for, and not counted until it arrives), and who can read and sign off.
- **In Chromium, on Postgres 16,** with the dev seed, the members' web app and the website's build served locally:
  1. The Overview said 29 things were left, and the checklist listed them.
  2. Razorpay, Google Play and Bunny called their webhooks, signed as each signs, and a guess at Play's secret was turned away. Those three lines went green.
  3. The web app got its link files, which left only https on that line.
  4. Finance filled in the seller and the export footnote on Money settings.
  5. The owner signed off the lawyer's read, with a note.
  6. At phone width, nothing ran off the side.

  The screens are in `docs/screens/sprint-7d/`.

For phase 2 part 1:
- **The API suites** cover:
  - the sizes on the course page, once a video has its MP4 copies;
  - the link: one file, signed for six hours, at the quality asked for, with the tallest copy a short video has;
  - no downloads from a course the member doesn't have (not even its preview), a draft or a chapter still processing; an audio chapter as its M4A;
  - three phones: the fourth refused with the others named, one removed and the place freed, a phone not online for 30 days not counting, an emptied phone freeing its place;
  - check-ins: renewed, a re-uploaded chapter, a refund, a deleted chapter, a chapter the server had lost track of, and a phone removed elsewhere;
  - a subscription that stops renewing (downloads play to the end of the month), then runs out;
  - Bunny's webhook noting the copies, and the checklist's button reading older videos again;
  - the data download, and heartbeats played offline counting on their own day without moving a newer place back.
- **The app's tests** run the download manager and the heartbeat queue with the phone and the network played by test code (listed in [the app's README](apps/mobile/README.md#check-it)).
- **`expo prebuild`** in a scratch copy: Android's manifest now points at the backup rules, and iOS asks about nothing new. The iOS and Android bundles built with the download code in them, and the web bundle without it.
- **In Chromium, at phone size, on Postgres 16:** a build of the members' app with the real download manager, where only the phone's storage was played by the browser, and the dev seed's video sent at 350 KB a second. In order:
  1. The member's downloads were already on three phones, so her first chapter stopped with the server's message. Downloads listed the phones; she took an old Galaxy off and the chapter went ahead.
  2. She asked for the rest of the course and lost Wi-Fi halfway through the next chapter. The queue waited, then carried on from 1.2 MB in, with a fresh link, when Wi-Fi came back.
  3. Online, a saved chapter played from the phone without touching the video server.
  4. Offline, Library said so and pointed to Downloads, and a chapter played from there, offering the next saved one. Its two heartbeats reached the database with their own times once the connection was back.
  5. Two chapters of Gentle Spine were downloaded, the course was taken back, and the next check-in removed them and said why.
  6. She signed out. The phone was left with nothing, and the server forgot it.

  The screens are in `docs/screens/phase-2a/`.

For phase 2 part 2:
- **The app's tests** run the casting controller with a pretend Chromecast and a hand-wound clock (listed in [the app's README](apps/mobile/README.md#check-it)).
- **The API suites** count the two cast events on Beta health.
- **`expo prebuild`** in a scratch copy:
  - **Android:** the Cast SDK is pinned at 22.3.1, the manifest has the options provider, the receiver ID and the full-screen controller, and MainActivity starts the Cast context.
  - **iOS:** Info.plist has the local network text and the two Bonjour services. AppDelegate sets the Cast SDK up before React Native starts, with discovery waiting for the first tap.
  - **Bundles:** the iOS and Android bundles have the Cast SDK's JavaScript and the casting controller; the web bundle has neither.
- **In Chromium, at phone size, on Postgres 16:** a build of the members' app with the real casting controller, heartbeats and API, where only the Chromecast and Google's button were played by the browser. In order:
  1. A chapter played on the phone for 3 seconds, then went to the TV from there.
  2. Half a minute on the TV put a 29-second heartbeat in the database. Then a 5-second pause and a 15-second skip; the next heartbeat carried 8 seconds, so neither counted.
  3. Next went to the TV, which couldn't play it. The player said so and offered the phone, and the failure reached the events table.
  4. "Play on this phone" played it there, still connected, and "Play on Living room TV" sent it back from the phone's 4 seconds.
  5. "Stop playing on the TV" left the phone paused at the TV's 15 seconds.
  6. Connecting again sent it from 15 seconds. Played to the end on the TV, it was marked done, with its place at the end.

  The screens are in `docs/screens/phase-2b/`.

## Bunny check: do this with a real library before real uploads

The signing code follows Bunny's published reference implementation, but only a real library proves it works.

1. Create a Stream library and fill in the `BUNNY_STREAM_*` values in `.env`.
2. In the library's pull zone, turn on token authentication and put the key in `BUNNY_STREAM_TOKEN_KEY`.
3. Point the library's webhook at `https://<api>/v1/webhooks/video?secret=<BUNNY_WEBHOOK_SECRET>`. Locally, use a tunnel such as cloudflared.
4. Upload a test clip from the studio. Confirm the chapter turns `ready`, then play it in the app.
5. For audio, create a Storage zone and a pull zone in front of it with token authentication on. Fill in the `BUNNY_STORAGE_*` and `BUNNY_AUDIO_*` values, upload an audio chapter from the studio, and play it.
6. For downloads, switch on MP4 fallback in the library's Encoding settings before the first real upload. Bunny only makes the downloadable copies for videos uploaded after that. Upload a clip, and once it's ready the course page should show a download arrow next to it. Videos already up need re-encoding in Bunny's dashboard; then press "Look at Bunny again" on the launch checklist.

## Downloads check: on real phones before this goes out

The download manager and the API were tested here, and the screens walked in a browser standing in for the phone's storage. What only a phone can show, on one Android phone and one iPhone, with a release build:

1. **A chapter on Wi-Fi.** It downloads, then plays in airplane mode.
2. **Leaving Wi-Fi halfway through a course.** The queue waits ("Waiting for Wi-Fi") and carries on from where it was when Wi-Fi is back. With mobile data allowed it carries on at once.
3. **The iPhone in a pocket.** With mobile data allowed, start a course download and lock the phone for a few minutes: it keeps going. With Wi-Fi only it waits until Embodha is opened again.
4. **Swiping the app away mid-download.** On opening it again the chapter starts over, or is kept if it finished in the meantime.
5. **Practice offline.** In airplane mode, Library says it's offline and points to Downloads. Play a chapter for a minute, reconnect, and the minutes show on the streak.
6. **A nearly full phone.** A course bigger than the space left stops with the message about room, rather than filling the phone.
7. **Signing out.** The app's storage in the phone's settings drops back.
8. **Android backups.** With a few downloads on the phone, Settings, Google, Backup should show the app's backup staying small.

## Chromecast check: on a real TV before this goes out

The casting logic was tested here with a pretend Chromecast, and the screens walked in a browser standing in for the TV. What only a real TV can show, with a Chromecast or Google TV on the same Wi-Fi as an Android phone and an iPhone, on release builds:

1. **A class from Bunny.** Cast a real chapter, with token authentication on. It should start where the phone was, with the course name and the picture on the TV. If the TV says it couldn't play it, look at the video library's pull zone in Bunny. The TV fetches the playlist and segments from a web page, so they need CORS headers, and an allowed-domains (referrer) list will turn the TV away. Then cast an audio chapter: it gets the music screen.
2. **The remote.** Pause, play and skip from the phone, then from the TV's own remote. The player should follow both.
3. **The iPhone's first tap.** The local network question appears once, with the app's text, and then the list of TVs. Check that the list, and the sheet with "Stop casting" when connected, open over the app (the iOS template uses a scene delegate).
4. **Android's notification.** While casting, the notification and the lock screen have play, pause and stop, and tapping it opens the full-screen controls. With the app's notifications off there's no notification, and casting still works.
5. **A locked phone.** Cast a 10-minute chapter and lock the phone. On Android, the minutes show on the streak straight after. On the iPhone, open the app while the TV still shows the class: the minutes should count.
6. **Leaving and coming back.** "Stop playing on the TV" leaves the phone waiting where the TV got to. Switching the TV off mid-class does the same, once the phone notices. Closing and reopening the app mid-class, the player follows the TV rather than starting the chapter again.
7. **Two phones.** Connect a second phone to the TV while a class plays. It shows the class, and only the phone that sent it counts the minutes.
8. **The release build.** R8 is on. The Cast SDK brings its own keep rules, but this is the build where a stripped class would show, as a missing Cast button or one that does nothing.
9. **A phone without Google Play services,** if there's one to hand: no Cast button, and nothing else changes.

## Device check: on a low-end Android phone before the beta

The spec's launch bar includes video starting within 2 seconds on 4G, and smooth use on the phones most members will have. Measure it on a real phone around ₹8,000–10,000 (2–3 GB of memory), with a release build from EAS (`eas build --profile preview --platform android`):

1. **Cold start to Today:** the time from tapping the icon until Today shows. Aim for under 3 seconds.
2. **Scrolling:** Today, Explore and a long course page should scroll without visible stutter. Android's "Profile HWUI rendering" bars in Developer options show dropped frames.
3. **Video start:** time from tapping a chapter to the first frame, on mobile data, in three cities. The aim is under 2 seconds.
4. **An hour of use:** play two chapters and a breathing session, then check the app's memory in Developer options under Running services. It should come back down after leaving the player.
5. **The minified build works:** sign in, buy in the sandbox, play video and audio, and get a push notification. R8 shrinking can break native code that hasn't declared its rules, so this has to be tried once.

Anything that misses goes back as a sprint 5 task, with the number measured.

## Store check: do this before the first real purchase

1. **App Store Connect:** create the app with bundle ID `com.embodha.app`. Under Users and Access, Integrations, In-App Purchase, generate a key. Put the issuer ID, key ID and the `.p8` file's text in `APPLE_ISSUER_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`.
2. **App Store notifications:** in the app's App Information, set App Store Server Notifications to version 2, with both the production and sandbox URLs at `https://<api>/v1/webhooks/apple`.
3. **Google Play:** create a service account in a Google Cloud project and download its JSON key into `GOOGLE_PLAY_SERVICE_ACCOUNT`. In Play Console, under Users and permissions, invite its email with "View financial data" and "Manage orders and subscriptions".
4. **Play notifications:** create a Pub/Sub topic and give `google-play-developer-notifications@system.gserviceaccount.com` the Publisher role on it. Add a push subscription to `https://<api>/v1/webhooks/google?secret=<GOOGLE_PLAY_RTDN_SECRET>`. Put the topic in Play Console under Monetization setup, then press "Send test notification". The API's log should show it.
5. **Products, made by the server:** in App Store Connect, under Users and Access, Integrations, App Store Connect API, make a team key with the App Manager role. Put its ID and text in `APPLE_CONNECT_KEY_ID` and `APPLE_CONNECT_PRIVATE_KEY`, and the app's Apple ID in `APPLE_APP_ID`. In Play Console, give the service account "Manage store presence" as well. Then press "Check on everything now" on Store products. Courses already on sale get their products, and each row shows where it stands. Apple takes an app's first products only with a new app version: add them to the next version in App Store Connect when the page says so. (Without these keys, make the products by hand at the same prices, give each teacher their own subscription group in App Store Connect, and link them on Store products.)
6. **A test purchase in each store,** with a sandbox account on TestFlight and a licence tester on Play's internal track. The course should unlock, and Payments should show the sale as a test. Then refund the Play one from Order management: it should leave the member's library within a minute.

## Deploying to the Hostinger VPS

`apps/api/Dockerfile` builds a small Node 22 image that runs migrations, then the API.

- **App VPS:** Docker, with Caddy in front of port 3000 for TLS.
- **Website:** `apps/site` builds to static files for the main domain. Fill in `site.config.json` and build with `npm run build:release`. [Its README](apps/site/README.md) has the Caddy block, with its security headers, and where each page's address goes in App Store Connect, Play Console and Razorpay.
- **Studio and admin:** `apps/web` builds to static files. Caddy can serve them on a subdomain such as `studio.<domain>`. Add that origin to the API's `CORS_ORIGINS`.
- **Members' web app:** this is where website purchases happen, through Razorpay.
  - `apps/mobile` builds for the web too: `npm run web:release` writes to `dist-web`. Set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SITE_URL` for it, plus `APPLE_TEAM_ID` and `ANDROID_CERT_SHA256` for the sign-in link files.
  - Serve it on a subdomain such as `app.<domain>`, with every path falling back to `index.html`. [The app's README](apps/mobile/README.md#once-before-the-first-build) has the Caddy block.
  - Set the API's `WEB_URL` to it, because the one-tap link in sign-in emails opens there. Add it to `CORS_ORIGINS` too.
- **Database VPS:** Postgres, reachable only from the app server. Back it up with a nightly `pg_dump` plus WAL archiving to off-site storage. The privacy policy states how many days backups are kept (`backupDays` in the site's config), so keep the two in step.
- **Production guard:** the API refuses to boot without real SMTP mail, a Bunny token key, a webhook secret and an https `WEB_URL`.
- **App Store and Google Play:** the steps are under "Store check" above. With those keys unset, the API refuses store purchases politely and everything else runs.
- **Razorpay:** add the API keys, and point a webhook at `https://<api>/v1/webhooks/razorpay`. Turn on the events `payment.captured`, `refund.processed`, `subscription.charged`, `subscription.cancelled`, `subscription.halted` and `subscription.completed`. Subscriptions also have to be enabled on the Razorpay account. Test-mode keys work the same way, so the whole flow can be tried with Razorpay's test cards first.

The app ships through the App Store and Google Play. The steps to take before the first store build are in [the app's README](apps/mobile/README.md#before-the-first-store-build).

## Defaults for questions the spec leaves open

- **Split base:** instructors' percentages apply to the net, after GST and fees (`split_base` in settings).
- **Default share:** 60%, a placeholder until the client decides.
- **Quiet hours:** 10 pm to 8 am on the member's own clock (India's if the account has no time zone). They hold back pushes from Embodha, not the member's own reminder, whose time they chose.
- **Reminder times on offer:** 7 am, 9 am, 1 pm, 6:30 pm and 9:30 pm, or Off. A handful of sensible times is quicker to pick than a clock face.
- **Minimum age:** 18 (`MIN_AGE`).
- **Currency:** guests are priced by their phone's region (India gives INR, anywhere else USD). Members are priced by the country on their account.
- **Free course:** exactly one, enforced by a unique index.
- **Refund window:** 7 days (`refund_window_days`). A share is paid out only after it, and members can't refund themselves.
- **The website's refund promise:** a course bought on the website is refunded in full within that window, with no reason needed. Subscriptions aren't refunded for part of a month, but a mistaken charge always is. `refundWindowDays` in the site's config has to match `refund_window_days`.
- **Complaints:** acknowledged within 48 hours and resolved within a month. That's what India's e-commerce rules ask, and inside the data protection law's limit.
- **Place of supply:** the state on the buyer's account, which website checkout insists on (CBIC circular 242/36/2024-GST). Only a renewal for someone without one falls back to the seller's state, and the GST page counts those.
- **CGST and SGST:** each half of the GST already inside the price. When that's an odd number of paise, SGST carries the extra one, so the invoice always adds up to the price.
- **Store sales:** no GST split and no Embodha invoice, because Apple and Google are the sellers in the apps. Confirm that with your accountant.
- **Document numbers:** EMB/26-27/000001 for invoices and CN/26-27/000001 for credit notes, each series starting again in April.
- **Payouts:** monthly, with a minimum of ₹500 (`min_payout_paise`); anything less carries over.
- **Dollar sales:** on the website, at Razorpay's own conversion, which comes with the payment. In the apps, at `usd_inr_rate` (a placeholder of 88) until the store's report gives the real proceeds and the store's own rate: Google's is in its earnings report, and Apple's is the one finance types in.
- **Razorpay's fee:** booked without the GST Razorpay adds to it, which comes back as input credit. A payment that arrives without its fee is estimated at 2% (3% for a card from abroad) until its settlement.
- **Store commission:** 15% of the price before GST (`store_commission_bps`), the rate in both stores' small-business programmes.
- **Store prices:** each store product is priced by hand to match the course's rupee and dollar prices. Store sales in rupees and dollars are booked as charged. Sales in other currencies are booked at the dollar price, and the stores' monthly reports are the final word.
- **GST on a store sale:** if a store pays out more than the price after GST and its commission would leave, it has passed the GST on for Embodha to pay. The share is then worked out on what the store paid less that GST, and the report's line says so. Settle with your accountant which way each store does it in India.
- **When a sale counts as late:** on Razorpay, after 4 days for rupees and 11 for dollars. On Google Play, once that month's earnings report is in, since each report covers its whole calendar month. On the App Store, once a report reaches past the sale, with 2 days' grace because Apple's fiscal month ends on a Saturday, Pacific time.
- **App Store units:** each goes to the oldest sale not yet matched with the same product, price and currency, made before the fiscal month ended (plus the grace).
- **The SAC on invoices:** the launch checklist doesn't insist on it, because it's optional on invoices to consumers while turnover is under ₹5 crore. The seller line says so.
- **A webhook counts as heard** once its signature or secret checks out. Apple's notifications aren't signature-checked (Embodha asks Apple about each transaction instead), so for Apple "heard" means the URL works, no more.
- **"Waiting" on the launch checklist** means there's nothing to do but wait: a store's review, or the beta's data. It still holds launch up.
- **Video start by state:** a state counts once it has five starts, on any connection, with 9 in 10 of them within 2 seconds.
- **Streaks:** any day with a breathing session or actual playback counts, in the member's own time zone.
- **Completion:** a chapter is done at 95%, or when the player reaches the end.
- **Breath on launch:** on by default, once a day, with Skip. Members can switch it off.
- **Crash-free sessions:** a session is each launch and each return to the app, and a screen that failed to draw counts as a crash as well as the app closing. That's stricter than the stores' own figures, which only count the app closing.
- **When a launch bar is judged:** after 100 phone sessions for crash-free, and 30 starts on 4G for video. Before that the page says it needs more data.
- **Suggested categories:** Sleep, Mobility, Pilates, Kickboxing and Pre/postnatal are seeded but switched off until approved.
- **Downloads:**
  - **Phones:** on 3 per account (`DOWNLOAD_DEVICE_LIMIT`). A phone that hasn't been online for 30 days doesn't count.
  - **Playing offline:** for 30 days after the last check-in (`DOWNLOAD_KEEP_DAYS`), or to the end of the paid month for a subscription that isn't renewing.
  - **Mobile data:** Wi-Fi only until the member allows it.
  - **Quality:** Standard means the tallest copy at or under 480p; High, at or under 720p.
  - **Room:** 300 MB always left free on the phone.
  - **Links:** 6 hours (`DOWNLOAD_URL_TTL_S`).
  - **What can be downloaded:** only a course the member has, not the free preview of one they don't.
- **Downloads on an iPhone, Wi-Fi only:** they run while the app is open, because iOS can't be told to keep a background download off mobile data.
- **Chromecast:**
  - **Receiver:** Google's Default Media Receiver (`CC1AD845` in `app.json`), so nothing is registered with Google and the TV shows Google's own player.
  - **Connected:** a chapter opened goes to the TV, from where the phone was or where the member left off. The phone never starts a chapter the TV has had; "Play on this phone" brings it back.
  - **Counting:** the TV's progress, bounded by the clock, counted by the phone that sent it.
  - **A chapter the TV can't play:** one more try saying fMP4, for an HLS stream, then the phone is offered.
- **No DRM on downloads.** The file sits in the app's own storage, out of reach on an ordinary phone, though a rooted or jailbroken one could copy it. The spec holds DRM back until piracy shows up, and DRM with downloads would need offline licences as well.

## Layout

```
apps/api/src/
  auth/        sign-in, tokens, account
  catalogue/   categories, home, library, courses, access rules, playback
  practice/    breathing sessions, heartbeats, progress, streaks
  admin/       staff endpoints: review, instructors, members, catalogue, quotes, reports
  reviews/     member reviews and their moderation
  notes/       private notes, encrypted at rest
  notifications/  devices, the bell, campaigns (now or scheduled), quiet hours, daily reminders, Expo push
  studio/      instructor courses, chapters, uploads
  media/       Bunny API, URL signing, webhook
  money/       Razorpay, App Store and Google Play: checkout, receipts, webhooks, store products, payments, splits, refunds, payouts;
               GST: place of supply, the CGST/SGST/IGST split, invoice and credit note PDFs, the month's report;
               reconciliation: Razorpay's settlements and the stores' monthly reports against the books (reports.ts reads the files)
  analytics/   app events, the daily rows they roll up into, and the admin report
  beta/        crash and error reports, feedback, and Beta health: the launch bars against their targets
  launch/      the launch checklist: what the server can check for itself, webhooks heard from, and sign-offs
  downloads/   offline downloads: what a phone may save and its link, the three-phone limit, check-ins
  privacy/     the data download, deleting an account, and erasing it 30 days later
  db/          schema, migration runner, seed data
  common/      guards, errors, helpers
apps/api/test/       end-to-end suites
apps/api/drizzle/    generated SQL migrations (npm run db:generate after schema changes)
apps/mobile/src/app/ screens (Expo Router)
apps/mobile/src/lib/ API client, session, auth, types, the website's address, downloads, casting
apps/mobile/src/ui/  theme and shared components
apps/web/src/pages/  studio and admin screens
apps/web/src/lib/    API client, session, types
apps/site/src/       the public website: pages/, the layout around them, styles
apps/site/build.mjs  fills in site.config.json and writes dist/
assets/brand/        logo
docs/screens/        screenshots from each sprint's walk-through
```

## Next: the beta, and the rest of phase 2

Sprint 7's building is done. The Launch checklist in admin now tracks what's left, line by line; these are the steps behind its open lines:

- **Money settings, before the first website sale:**
  - the seller's legal name, address, GSTIN and SAC;
  - for exports, the footnote with the LUT.

  Every invoice keeps the details it was issued with. A sale made before these are set stays without them.
- **Your accountant:** walk them through a month on the GST page and its two CSVs, and settle two things with them:
  - which SAC to print;
  - that Apple and Google account for GST on sales in the apps.

  Invoices issued electronically don't need a signature under Rule 46.
- **The website:** fill in its details and have a lawyer read the pages ([the site's README](apps/site/README.md#before-it-goes-live)).
- **The builds:** the one-time EAS setup and the first TestFlight and Play builds ([the app's README](apps/mobile/README.md#builds-for-the-beta-and-the-stores)).
- **The website's address on the API:** set `SITE_URL`, so the checklist can see the pages and check the refund promise against Money settings.
- **An inbox for feedback:** set `FEEDBACK_EMAIL` on the API to the address the team reads. Without it, feedback still collects on the Feedback page.
- **An inbox for finance:** set `FINANCE_EMAIL` for the nightly money check's emails. Razorpay's settlements are fetched with the API keys already set.
- **Once part 3 is deployed:** on Reconciliation, fetch Razorpay's settlements from the day of the first beta payment, 31 days at a time.
- **Each month, from then on:**
  - Play's earnings report goes on Reconciliation once Google has made it, near the start of the month: Play Console, Download reports, Financial.
  - Apple's financial report goes on once it's out, by the first Friday of Apple's next fiscal month: App Store Connect, Payments and Financial Reports, Create Reports, "All Countries or Regions (Single File)". When Apple pays for that month, type in the rupee rate from the payment for any dollars.
  - Anything left under "Needs a look" gets a line saying what it was.
- **The switch-off test:** before the beta's money is real, subscribe to a teacher from a test account on each channel (a website test payment, TestFlight's sandbox, a Play licence tester), then switch the teacher's plan off. Beta health shows whether anything was charged after.
- **Then:** the "Device check" and "Store check" above, and the outside penetration test in [SECURITY.md](SECURITY.md). Each has a line on the checklist to sign off.

For downloads, before the first real upload: switch on MP4 fallback in the Bunny library (step 6 of the Bunny check). Then run the downloads check above on two phones. For Chromecast, run the Chromecast check on a real TV with a chapter from that library.

Phase 2 in the spec carries on with Razorpay inside the Android app. After that: Google and Apple sign-in, a Hindi interface, website checkout for EU and UK buyers once VAT registration is in place, the remaining reports, and DRM if piracy shows up. Offline downloads and Chromecast are done.
