# Embodha app

The members' app for iOS and Android, built with Expo SDK 58, React Native 0.88 and Expo Router. The same code also builds for the web, which is handy for previews and screenshots.

## What's in it

- **Today.** A greeting, today's breath, the line, photo and short video of the day, and "pick up where you left off". It also shows the free course, the categories and the newest courses.
- **Breathing.** Four patterns: box, 4-7-8, slow and long sigh. A circle grows on the in-breath and shrinks on the out-breath. Phones give a light tap at each change, so it works with eyes closed. The patterns ship inside the app, so breathing works offline and on first launch. The first open of each day starts on a breath with a Skip button, and members can turn that off under You.
- **Explore.** Categories and topics, with how many courses each topic has.
- **Courses.** Each course page shows the price in rupees (GST included) or dollars, the free preview chapter, the instructor's monthly subscription, any cautions and equipment, and the chapter list with locks and ticks.
- **Player.** Video with picture-in-picture, and audio with lock-screen controls. It resumes where the member left off and offers the next chapter. A locked chapter shows the ways to unlock it. AirPlay is in a video's own controls on an iPhone; an audio chapter gets an AirPlay button next to the course name, for a HomePod or an Apple TV.
- **Progress.** While something plays, the app tells the API every 30 seconds how far the member got and how long they actually played. Seeking doesn't count as playing. Each beat waits on the phone until the server has it (`src/lib/beats.ts`), through closing the app, so practice done offline counts too, on the day it was done. Finishing a chapter ticks it off, and the same numbers feed the streak.
- **Downloads** (phone apps only; the web build streams). Members keep chapters of courses they have on the phone and play them without a connection:
  - **On a course page,** each chapter has a download arrow, and under Start a button downloads the whole course with its size. A tap on a saved chapter's arrow removes it.
  - **One chapter at a time,** on Wi-Fi unless the member allows mobile data. A download that stops (Wi-Fi gone, or Pause) carries on from the bytes it has; one cut off by the app being closed starts again. On an iPhone, a Wi-Fi-only download runs while Embodha is open, because iOS can't be told to keep a background download off mobile data; with mobile data allowed it carries on in the background.
  - **The server says yes first,** for every chapter: the course is the member's (not just its preview), and the account's downloads aren't already on three phones. If they are, Downloads lists the phones so one can be removed.
  - **They play offline for 30 days** after the phone was last online, and every check-in starts that again. A check-in also removes chapters whose course stopped being the member's (a refund, a subscription that ran out, a course taken down), says why, and fetches again any the teacher re-uploaded.
  - **Room on the phone:** a download only starts with 300 MB to spare after it. Quality is Standard (480p, about 12 MB a minute) or High (720p, about 23 MB); audio is about 1 MB a minute either way.
  - **Signing out** frees the phone's place on the server and deletes the files. Someone else signing in on the same phone starts empty.
  - **Offline,** screens that can't load say so and point to Downloads, the player plays the saved copy (and offers the next chapter if that's saved too), and notes wait for a connection.

  Files go in the Caches folder on an iPhone (not backed up to iCloud; iOS may clear it when the phone is nearly full, and the app then says the chapter is no longer on the phone) and in the app's own files on Android (left out of Google's backups by expo-secure-store's backup rules, set in `app.json`). The list of what's saved, `embodha-downloads.json`, is kept with the app's documents.
- **Chromecast** (phone apps only). Google's Cast button sits next to the course name on the player. It finds the TVs on the Wi-Fi and connects; on an iPhone it waits for the first tap before looking, which is when iOS asks about the local network.
  - **Connected, the chapter goes to the TV** from where the phone was, and the player becomes a remote: what the TV is doing, where it's got to, pause, 15 seconds either way, and "Stop playing on the TV". Next, and any chapter opened while connected, goes to the TV too. Opening the app mid-class, the player follows what the TV already has rather than starting it again.
  - **Leaving the TV** (Stop, the TV switched off, the phone out of range), the phone moves to where the TV got to and waits there, paused. Once the TV has had a chapter, the phone never starts it on its own; "Play on this phone" brings it back while staying connected.
  - **The TV streams** the same signed link the phone would, through Google's Default Media Receiver, so a downloaded chapter is cast from the stream and there's no button offline. If the TV turns an HLS stream down, the app asks once more saying its segments are fMP4, then says the TV couldn't play it and offers the phone.
  - **What the TV plays counts,** with the usual heartbeat every 30 seconds, sent by the phone. It counts how far the TV moved, never more than the clock says passed, and nothing while paused, so skipping ahead isn't practice. A chapter played to the end is done. In the background Android keeps listening; iOS stops the app, and the stretch it slept through is made up when the app opens again, if the TV still has the class up. Each phone counts only the chapters it sent (a random tag goes with each), so a phone and a tablet on one account don't count one class twice.
  - **Without Google Play services** (some Huawei phones) or in a development build made before Chromecast went in, there's no button and nothing else changes.
- **Sign-in.** Email plus a six-digit code, or the one-tap link in the same email (`/auth/link?token=…`).
  - After sign-up the app asks for name, country, year of birth and goals. Country sets prices and GST, and year of birth covers the 18+ rule.
  - Members in India also pick their state, found by typing a few letters. It decides whether a website invoice carries CGST and SGST or IGST.
  - The same screen opens from You, under "Your details", to change any of it. Tokens live in the Keychain or Keystore. The app refreshes an expired session once, even when several requests hit it together.
- **Search.** From Explore, across course titles, descriptions, topics and teacher names.
- **Reviews.** Members who have played a course can give it stars and a few words. Admin's replies show underneath.
- **Notes.** Private notes under the player, each pinned to the moment it was written; tap the time to jump back. They're encrypted on the server.
- **Notifications.** The bell on Today shows unread messages and keeps a history.
  - Push: the app asks once, right after the details screen, and You has a switch.
  - Sign-out forgets the phone, so the next person doesn't get the last one's messages.
  - Tapping a notification opens the screen it points to.
- **Guests.** Guests can breathe, take the free course and play previews without an account. Prices follow the phone's region until they sign in.
- **You.** Streak, minutes practised, your details (name, country, state in India, year of birth), the breath-on-launch switch, the daily reminder (a time, or Off), sign out and delete account. Deleting stops renewals and erases the account after 30 days; the app says when, and how to cancel an App Store subscription if there is one.
- **The website.** With `EXPO_PUBLIC_SITE_URL` set, the app links to the public website (`apps/site`) in three places:
  - **You** has "Privacy policy · Terms of use · Help" at the bottom, signed in or not.
  - **Sign-in** says that continuing means agreeing to the terms and the privacy policy.
  - **Every subscription offer** has the terms and the privacy policy under its button, on the course page and on a locked chapter.

  Without the variable, none of these show, so development builds don't link to a site that isn't there.
- **Analytics.** `src/lib/analytics.ts` queues a few named moments (opens, screens, course pages, locked chapters, purchases, breaths, how long chapters take to start) and sends them to the API in batches. Add a name to `EVENT_NAMES` in the API before sending it, or the API drops it. "Share how you use the app" under You switches it off for that phone.
- **Crash and error reports** (`src/lib/crashes.ts`), sent to Embodha's own API, not to an outside service:
  - A crash is written to the phone as it happens and sent on the next launch.
  - A screen that fails to draw shows "This screen didn't load", with Try again and Go to Today, and is reported as a crash straight away. Every route file exports that page (`src/ui/error-boundary.tsx`), so the tabs and the way back keep working around it.
  - Other errors nobody caught, promises included, go up a few seconds later, each different one once per launch and twenty at most.
  - A report has the message and stack, the screen, the app version, and the phone's model and system version. "Share how you use the app" switches reports off too, and development builds never send any.
- **How long chapters take to start.** The player times each chapter from opening to the first frame (or first sound, for audio), and sends it with the connection: Wi-Fi or mobile data, and 4G or 5G. The type comes from NetInfo, set up so it never pings Google to check the connection. Leaving before anything plays sends the wait, marked abandoned.
- **Feedback.** Under You, Feedback: a message to the team, sent with the app version and phone model. It lands on admin's Feedback page and, with `FEEDBACK_EMAIL` set on the API, in that inbox with the member's address to reply to.

**Buying in the iOS and Android apps.** Apple and Google require their own billing for anything digital sold inside an app, so courses and teachers' subscriptions are bought through the App Store or Google Play.
- **The price** on the button is the store's own, in the member's currency, once the store has answered. Until then it shows Embodha's.
- **Nothing unlocks on the app's word.** The store takes the payment, the app sends the purchase to the API, and the API checks it with Apple or Google. Only then does the app tell the store the purchase is done. If the phone drops out halfway, the store offers the purchase again on the next launch and it goes through then.
- **One account.** Every purchase carries the member's Embodha ID, so it can't be claimed from another account. "Restore purchases" under You finds earlier purchases on a new phone.
- **Payments that clear later,** like Ask to Buy on an iPhone or a cash payment on Android, unlock when they clear.
- **Store subscriptions** are changed and stopped in the store, so Library links to the App Store's or Google Play's subscription page instead of showing "Stop renewing".
- **Not linked yet.** A course only has a working buy button once admin has linked it to its store product, on the Store products page. Until then the app says it isn't on sale in the app yet. It never points to the website, because Apple doesn't allow that in most countries.

**Buying on the web build.** "Unlock" opens Razorpay Checkout and unlocks the course once the payment is confirmed; Subscribe does the same with a monthly subscription to that instructor. Library shows when it renews and has a "Stop renewing" button. Purchases and invoice numbers show under You.

## The look

Flat pastel grounds (each tab has its own), bright tiles drawn with an ink outline, and three typefaces:
- **Italiana** for headlines: thin, high-contrast capitals.
- **Anton** for the few words that should land: heavy and condensed. Titles, buttons and numbers use it.
- **DM Sans** for everything people read.

There are no shadows and no gradients. Round, outlined "stamps" (like Today's breath) and the eight-point star are the only flourishes. Everything comes from `src/ui/theme.ts` and `src/ui/components.tsx`, so a change there reaches every screen. The breathing screen keeps its own night palette, because bright colour works against calm.

## Run it

Start the API first, with the dev seed loaded ([LOCAL-SETUP.md](../../LOCAL-SETUP.md) has every step). Then:

```bash
cd apps/mobile
cp .env.example .env        # EXPO_PUBLIC_API_URL, and optionally EXPO_PUBLIC_SITE_URL
npm ci
npx expo start --web        # http://localhost:8081
```

- **Web:** that's all. The API already allows `http://localhost:8081`.
- **A phone:** make a development build: `npx expo run:android` (Android Studio, with an emulator or a phone on USB) or `npx expo run:ios` (a Mac with Xcode). Expo Go won't do, because in-app purchases, Chromecast and push on Android need native code it doesn't carry. Point `EXPO_PUBLIC_API_URL` at your computer's LAN address, e.g. `http://192.168.1.20:3000`, because `localhost` on the phone is the phone; the Android emulator reaches your computer at `http://10.0.2.2:3000`.
- **Push notifications** need a real phone, a development build, and an EAS project. Run `npx eas init` once, which writes the project ID into `app.json`. Without one, the app quietly skips push and the bell still works.
- **Background audio and picture-in-picture** need a development build too.
- **Chromecast** needs a development build made since it went in, and a Chromecast or Google TV on the same Wi-Fi as the phone. The TV fetches the dev seed's public test stream itself, not through your computer; if it won't play that, try a chapter from a real Bunny library. The web build has no Cast button.

The dev seed points every chapter at a public test stream, so things play locally without a Bunny account. Sign in as `member@embodha.local`, or as any new address to see sign-up. The code is printed in the API's log.

## Check it

```bash
npm run typecheck
npm test              # 62 tests: downloads, heartbeats, casting, the purchase flow, the event queue, crash reports, start times, the state picker and the build settings
npm run web:build     # bundles every screen; catches import and bundling errors
```

`npm test` runs the download manager (`src/lib/downloads-core.ts`) with the phone's files, its network, the API and the file host played by test code. It checks one chapter at a time in order, waiting for Wi-Fi, carrying on from the bytes saved, the iPhone's background rule, the phone limit and the 300 MB kept free, a link that ran out, a server that's down (longer waits each time), check-ins that renew, re-download and remove, the keep date offline, the next launch after the app was closed or the phone cleared files, and signing out. It runs `src/lib/beats.ts` too: heartbeats kept through closing the app and sent in fifties once online.

It runs the casting controller (`src/lib/cast-core.ts`) with a pretend Chromecast and a clock the test winds by hand. It checks the load request (the signed stream, where to start, the course on the TV's screen), the second try in fMP4 and the newer chapter winning over one still loading, and the heartbeats: only time the TV played, never more than the clock allows, a waking phone making up what it slept through in beats of two minutes at most, and a finished chapter done once. Then whole sessions: a class sent, paused, skipped and finished; an iPhone asleep for five minutes mid-class; a session that never came back; another phone's chapter not counted; signing out mid-class; and a TV that can't play a chapter, then can.

`npm test` runs `src/lib/store.native.ts` in plain Node, with stand-ins for expo-iap, React Native and the API in `test/mocks/`. It checks the order of things that matter: the member's ID on every purchase, the server's check before the store is told the purchase is done, nothing left hanging when the sheet is closed, and retries after a dropped connection. It runs `src/lib/analytics.ts` the same way: batches, the offline cap, the switch and the new ID after signing out.

It runs `src/lib/crashes.ts` with the phone's error handler, the crash file and the browser played by test code: a crash written before the system closes the app and sent on the next launch, kept offline, dropped when the server refuses it, the five latest kept, nothing when sharing is off, errors sent once each and capped, rejected promises, a screen that failed to draw, and the web app ignoring other sites' scripts.

It also checks:
- the start clock: one reading per chapter, the server's part, and a wait marked abandoned;
- the state picker, and that its list of states matches the API's;
- that `app.config.ts` refuses a store build with an address missing, and what it adds to one;
- the Cast settings in `app.json`: Google's own receiver, the Android Cast SDK pinned to a version, and the iPhone's local network text;
- the sign-in link files that `npm run web:release` writes.

## Builds for the beta and the stores

Builds are made with EAS. `eas.json` has two profiles:
- **preview**: internal builds for the team's own phones. Android gets an APK to install directly; register each iPhone first with `eas device:create`.
- **production**: store builds, for TestFlight, Play's testing tracks and release. Build numbers go up by themselves on EAS's servers. The version people see is `version` in `app.json`: set it to `1.0.0` before the first release, and raise it for each one after.

`app.config.ts` adds what depends on where a build is going:
- **It refuses a store build that's missing an address.** It needs the API, the website (for the privacy policy and terms), and `EMBODHA_LINK_DOMAIN`, the members' web app that the one-tap sign-in link opens. A preview build needs the API.
- **The one-tap link opens the app.** It sets up universal links (iOS) and app links (Android) on `https://<EMBODHA_LINK_DOMAIN>/auth/link`, instead of the link opening the browser.
- **Apple's paperwork is done.**
  - "No special encryption" is declared, so App Store Connect stops asking about export compliance on every upload.
  - The privacy manifest lists the reasons for the system APIs the app's libraries use.
- **Android drops permissions the app never uses:** display over other apps, and the old storage ones. The stores' review would otherwise ask why the app has them.

### Once, before the first build

1. In `apps/mobile`, run `npx eas-cli@latest login`, then `npx eas-cli@latest init`. That writes the project ID into `app.json`.
2. Give each environment its addresses. They live on EAS, not in the code:
   ```bash
   eas env:set --environment production --name EXPO_PUBLIC_API_URL --value https://api.example.com --visibility plaintext
   eas env:set --environment production --name EXPO_PUBLIC_SITE_URL --value https://example.com --visibility plaintext
   eas env:set --environment production --name EMBODHA_LINK_DOMAIN --value app.example.com --visibility plaintext
   eas env:set --environment preview --name EXPO_PUBLIC_API_URL --value https://api.example.com --visibility plaintext
   ```
   `EMBODHA_LINK_DOMAIN` is the host in the API's `WEB_URL`.
3. Have the members' web app vouch for the app, or phones open the sign-in link in the browser. Build the web app with `npm run web:release`, with these two values set:
   - `APPLE_TEAM_ID`: from developer.apple.com, Membership details.
   - `ANDROID_CERT_SHA256`: Play Console, App integrity, the app signing key's SHA-256. Add the upload key's too, comma-separated, if testers install builds from outside Play; `eas credentials -p android` shows it.

   That writes `.well-known/apple-app-site-association` and `.well-known/assetlinks.json` into `dist-web`. Serve `dist-web` on that domain:
   ```
   app.example.com {
   	root * /srv/embodha-app
   	header {
   		Strict-Transport-Security "max-age=31536000"
   		X-Content-Type-Options "nosniff"
   		Referrer-Policy "strict-origin-when-cross-origin"
   	}
   	@appleSite path /.well-known/apple-app-site-association
   	header @appleSite Content-Type application/json
   	@hashed path /_expo/static/*
   	header @hashed Cache-Control "public, max-age=31536000, immutable"
   	try_files {path} /index.html
   	file_server
   }
   ```

### The closed beta

- **Build and send it:** `eas build --profile production --platform all`, then `eas submit --profile beta --platform all --latest`.
  - iOS builds land in TestFlight.
  - Android goes to Play's internal testing track, released to its testers at once.
- **iPhone testers:**
  - Internal testers are people on the App Store Connect team, up to 100. They get each build as soon as it's processed.
  - External testers, up to 10,000, join by email or a public link. Apple reviews the first build of each version before they get it.
  - TestFlight builds expire after 90 days.
- **Android testers:** the internal track takes up to 100, by email list. A bigger group goes on a closed testing track.
- **Paying in the beta:**
  - TestFlight purchases always run in Apple's sandbox, so they're free and booked as tests. That means iPhone money can't be reconciled until the app is live.
  - On Play, licence testers' purchases are tests too. Everyone else on the testing tracks pays for real.
- **Play Console asks about the background player.** The app plays audio in the background and video in picture-in-picture, which Android counts as a media playback foreground service. Declare it under App content, Foreground service permissions, with a short screen recording of a chapter playing after the app is closed.

### Before the first store build

- The bundle ID and package name are `com.embodha.app` in `app.json`. Confirm them before the first upload, because the stores never let them change.
- **Store forms.** Put the website's addresses in App Store Connect and Play Console ([the site's README](../site/README.md#before-it-goes-live) lists which goes where). Then answer the two privacy questionnaires so they match the privacy policy:

  | What the policy says is collected | App Store: App Privacy | Google Play: Data safety |
  |---|---|---|
  | Email address and name | Contact Info: Email Address, Name | Personal info: Email address, Name |
  | Year of birth, and gender if given | Other Data | Personal info: Other info |
  | Country | Coarse Location | Location: Approximate location |
  | Account ID; the app's random install ID and push address | Identifiers: User ID, Device ID | Personal info: User IDs; Device or other IDs |
  | What's played, breathing sessions, streaks | Health & Fitness: Fitness | Health and fitness: Fitness info |
  | Purchases | Purchases: Purchase History | Financial info: Purchase history |
  | Notes and reviews | User Content: Other User Content | App activity: Other user-generated content |
  | Searches | Search History | App activity: In-app search history |
  | Screens opened, purchase steps (can be switched off) | Usage Data: Product Interaction | App activity: App interactions (optional) |
  | Crash and error reports, how long chapters take to start and on what connection (can be switched off) | Diagnostics: Crash Data, Performance Data | App info and performance: Crash logs, Diagnostics (optional) |
  | Feedback sent from the app | User Content: Customer Support | App activity: Other user-generated content |

  - **Purposes.**
    - Everything is used for App Functionality, and usage, searches, crash reports and start times for Analytics too.
    - Crash reports and start times from a signed-in member carry their account, so both stores count them as linked to the person.
    - Country, year of birth and gender also pick who a message from the Embodha team goes to. That's "Developer's Advertising or Marketing" for Apple and "Developer communications" for Google.
  - **Nothing is used for tracking**, nothing is shared with third parties in either store's sense (the processors work for Embodha), everything is encrypted in transit, and members can delete their account in the app or at `/delete-account/`.
  - **Where the categories don't map neatly,** like a country picked from a list, the answers lean towards declaring more. Neither store turns an app down for that.
- **In-app purchases** need a development build or a store build; Expo Go can't buy anything. The `expo-iap` config plugin sets up Google Play Billing, and the App Store's In-App Purchase capability is on for every app ID.
- **Testing purchases.** On an iPhone, use a Sandbox Apple Account (App Store Connect, Users and Access, Sandbox) with a TestFlight or development build. On Android, add the testers as licence testers in Play Console and install from the internal testing track. These purchases unlock for real but are marked as tests: no invoice, no split, and they're left out of the totals on Payments.
- **App Review** buys in the sandbox too, so mark the products "In review" on the Store products page before you submit, or the reviewer won't see a buy button.

## Layout

```
src/app/            screens (Expo Router: every file is a route)
  (tabs)/           Today, Explore, Library, You
  course/[slug]     course page
  topic/[slug]      topic page
  play/[chapterId]  player (streams, or plays the saved copy), heartbeats, start timing, locked view
  downloads         what's on the phone, the queue, quality and mobile data, the phones with downloads
  breathe           breathing screen
  feedback          a message to the team, from You
  sign-in, onboarding, auth/link
src/lib/            API client and session, auth, types, formatting, breathing patterns, analytics, the website's address,
                    store.native.ts (App Store and Google Play) with store.ts standing in on the web,
                    crashes.ts (crash and error reports; the crash waits in crash-store.native.ts's file, or the browser's storage),
                    start-clock.ts and network.native.ts (how long a chapter took to start, and on what connection),
                    downloads-core.ts (the download manager) with downloads.native.ts wiring it to the phone and downloads.ts for the web,
                    beats.ts (heartbeats kept until the server has them, in beat-store.native.ts's file),
                    cast-core.ts (Chromecast: what the TV is sent, the connection, counting what it plays) with cast.native.ts
                    wiring it to react-native-google-cast and cast.ts for the web
src/ui/             theme, shared components, breath on launch, checkout (Razorpay on the web, the stores in the apps), the analytics bridge,
                    links to the website, the page a failed screen shows, the download buttons, the bridge that keeps
                    downloads with the member they belong to, Google's Cast button (cast-button.native.tsx; nothing on the web),
                    the TV panel the player shows while a chapter is on the TV, and the bridge that counts it for the member
test/               the tests and their stand-ins
scripts/            well-known.mjs: the sign-in link files for the members' web app
assets/             icon, Android adaptive icon, splash and logo, all made from the brand logo
app.config.ts       what changes by build: addresses, sign-in links, privacy manifest, permissions
eas.json            build profiles (preview, production) and where builds are submitted (beta, production)
```
