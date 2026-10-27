# Running Embodha on your own computer

This gets the whole thing running locally: the API with its database, the members' app in a browser, the studio and admin, and the public website. It works the same on Windows, macOS and Linux. The first time takes about 20 minutes, most of it downloads.

Nothing outside your computer is needed: no Bunny, Razorpay, Apple or Google accounts. Without their keys, video uploads, payments, store purchases and push are switched off, and everything else works. The dev courses stream a public test video, so you do need an internet connection.

## What to install first

- **Node.js 22** (the LTS version) from [nodejs.org](https://nodejs.org). `node -v` should print v22 or later.
- **Docker Desktop** from [docker.com](https://www.docker.com/products/docker-desktop/), for the database. If you'd rather use a Postgres you already have, see [Without Docker](#without-docker).
- For phones only: Android Studio, or a Mac with Xcode. See [On a phone](#on-a-phone).

Every command below runs in a terminal (PowerShell on Windows, Terminal on a Mac) from the `embodha` folder you unzipped, unless it says `cd` somewhere first. Unzip it to a short path without spaces, such as `C:\dev\embodha` or `~/dev/embodha`: Android builds trip over spaces and very long paths.

## 1. Start the database

```bash
docker compose up -d db
```

That's Postgres 17 on port 5432. The user, password and database are all `embodha`, and the data lives in a Docker volume, so it survives restarts. `docker compose ps` should show the `db` service as healthy after a few seconds.

## 2. Start the API

```bash
cd apps/api
cp .env.example .env
```

Open `apps/api/.env` and fill in `JWT_SECRET` and `CODE_SECRET`, each with a different random string of at least 32 characters. This prints one:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Leave everything else in `.env` as it is. Then:

```bash
npm ci
npm run db:migrate
npm run db:seed:dev
npm run dev
```

Keep this terminal open: it's the API's log. Check that http://localhost:3000/health says `{"ok":true}`. http://localhost:3000/docs lists every endpoint.

Sign-in emails don't go out locally. The six-digit code prints in this terminal instead, on a line like `To member@embodha.local: ... code is 482913`.

## 3. The members' app, in your browser

In a second terminal:

```bash
cd apps/mobile
cp .env.example .env
npm ci
npx expo start --web
```

It opens http://localhost:8081. The first open of the day starts on a breathing exercise; tap Skip. Then sign in from You as `member@embodha.local`, with the code from the API's terminal.

## 4. The studio and admin

In a third terminal:

```bash
cd apps/web
cp .env.example .env
npm ci
npm run dev
```

Open http://localhost:5173 and sign in as `admin@embodha.local` for admin, or `asha@embodha.local` for an instructor's studio.

## 5. The public website (optional)

```bash
cd apps/site
npm ci
npm run build
npx serve dist -l 8090
```

It's at http://localhost:8090. For the app's privacy and terms links to point there, set `EXPO_PUBLIC_SITE_URL=http://localhost:8090` in `apps/mobile/.env` and restart step 3.

## Who to sign in as

| Email | Who |
| --- | --- |
| `member@embodha.local` | A member |
| `asha@embodha.local` | An instructor, on 60%, with a monthly subscription switched on |
| `admin@embodha.local` | Super admin |

Any other address signs up as a new member. The dev seed has two courses: *Morning Breath, 5 Days*, the free one, and *7-Day Gentle Spine* at ₹999 or $12, with its first chapter free.

## On a phone

Expo Go won't do for this app: in-app purchases, Chromecast and push on Android need native code that Expo Go doesn't carry. Make a development build instead. It's your own copy of the app, built on your computer, that loads the code from the terminal like Expo Go would.

**Android.** Install Android Studio and either start an emulator from it or plug in a phone with USB debugging on. In `apps/mobile/.env`, point the app at the API:

- in the emulator: `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000`
- on a real phone on the same Wi-Fi: `EXPO_PUBLIC_API_URL=http://192.168.1.20:3000`, with your computer's own address (`ipconfig` on Windows, `ipconfig getifaddr en0` on a Mac). If the phone can't reach it, let Node through your computer's firewall.

Then, in `apps/mobile`:

```bash
npx expo run:android
```

The first build takes 10 to 20 minutes while Gradle downloads what it needs. After that it's quick, and `npx expo start` reloads the app as you change code.

**iPhone.** This needs a Mac with Xcode. `npx expo run:ios` builds for the simulator, where `localhost` works as it is. A real iPhone needs signing with an Apple developer account (`npx expo run:ios --device`).

Push notifications also need an EAS project: run `npx eas init` once in `apps/mobile`. Chromecast needs a Chromecast or Google TV on the same Wi-Fi as the phone.

## Stopping, and starting again

- **To stop:** Ctrl+C in each terminal, then `docker compose stop`.
- **Next time:** `docker compose up -d db`, then `npm run dev` in `apps/api`, `npx expo start --web` in `apps/mobile` and `npm run dev` in `apps/web`. There's no need to migrate or seed again.
- **A new zip:** unzip it to a fresh folder and copy your three `.env` files across (`apps/api`, `apps/mobile`, `apps/web`). Run `npm ci` in each app and `npm run db:migrate` in `apps/api`, then start as above. The database carries over.
- **Start the data from scratch:** `docker compose down -v` deletes the database. Then `docker compose up -d db`, and `npm run db:migrate` and `npm run db:seed:dev` in `apps/api`.

## Without Docker

Any Postgres 16 or 17 will do. As its admin user (`psql -U postgres`), create the user and the database:

```sql
CREATE ROLE embodha LOGIN PASSWORD 'embodha';
CREATE DATABASE embodha OWNER embodha;
```

If it isn't on `localhost:5432`, change `DATABASE_URL` in `apps/api/.env` to match. Then carry on from step 2.

## The API the way the server runs it (optional)

```bash
docker compose --profile api up --build
```

This builds the API's Docker image, the one the VPS will run, and starts it next to the database on port 3000. It applies the migrations itself on start, using the secrets in `apps/api/.env`. Stop `npm run dev` first, since both want port 3000. For the dev accounts and courses, run `npm run db:seed:dev` in `apps/api` once, with the containers up.

## When something's off

- **Docker says port 5432 is already allocated.** Another Postgres is running. Stop it, or change `"5432:5432"` to `"5433:5432"` in `docker-compose.yml` and use `localhost:5433` in `DATABASE_URL`.
- **The API stops with "needs at least 32 characters".** `JWT_SECRET` or `CODE_SECRET` in `apps/api/.env` is empty or too short.
- **The app or admin says it can't reach the server.** The API isn't running, or `EXPO_PUBLIC_API_URL` or `VITE_API_URL` points somewhere else. The API lets in pages from http://localhost:8081 and http://localhost:5173 by default (`CORS_ORIGINS` in `apps/api/.env`).
- **No code arrives.** It's in the API's terminal, not your inbox. A code lasts 10 minutes, and each address gets 5 an hour.
- **Videos don't play.** The dev courses stream a public test video, so check the internet connection. Real uploads need a Bunny library ([Bunny check](README.md#bunny-check-do-this-with-a-real-library-before-real-uploads) in the README).
- **A change to a `.env` file did nothing.** Restart that app. For the members' app, stop it and run `npx expo start --web --clear`.

The [README](README.md) has the rest: what each part does, the tests, the checks to run before going live, and deploying to the VPS.
