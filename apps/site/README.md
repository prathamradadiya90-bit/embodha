# Embodha website

The public site for the main domain: a home page, and the pages the app stores, Razorpay and Indian law ask for. It's plain HTML and CSS put together by `build.mjs`. There are no scripts, no cookies, no analytics, and nothing loads from another site; the three typefaces are served from the site itself. So there's no cookie banner either, because there's nothing for one to ask about.

## The pages

| Page | Address | Who asks for it |
|---|---|---|
| Home | `/` | |
| Pricing | `/pricing/` | Razorpay |
| Privacy policy | `/privacy/` | App Store Connect, Play Console and Razorpay. The app links to it from You, from sign-in and from every subscription offer. |
| Terms of use | `/terms/` | Razorpay, and Apple, next to anything sold as a subscription. The app links to it in the same places. |
| Refunds and cancellations | `/refunds/` | Razorpay |
| Shipping and delivery | `/shipping/` | Razorpay. Nothing is shipped, and the page says so. |
| Delete your account | `/delete-account/` | Play Console, as the account deletion URL |
| Help and contact | `/support/` | App Store Connect's support URL, and Razorpay's "Contact us". It also names the Grievance Officer and says how fast complaints are answered, as India's e-commerce rules ask. |
| Not found | `/404.html` | |

The pages were written from what the system actually does: what's stored and for how long, which companies handle it, what deleting an account erases and what it keeps. If that changes, say a new analytics event, a new processor or a different backup schedule, change the page in the same release.

## Before it goes live

1. **Fill in `site.config.json`** (below).
2. **Have a lawyer read the pages.** The facts are right for the system as built. The terms are still the company's choices, though: the liability cap, the courts, adults only, and the refund promise. Someone who can sign off on them should read them before launch.
3. **Build for release:** `npm run build:release`. It refuses to build while any detail is missing, and lists what's missing.
4. **Serve `dist/`** on the main domain (Caddy, below).
5. **Put the addresses into the consoles:**
   - **App Store Connect:** Privacy Policy URL (under App Privacy) is `/privacy/`, and Support URL (on the version page) is `/support/`. The app sells auto-renewing subscriptions, so also end the App Store description with "Terms of use: https://example.com/terms/". Alternatively, paste the terms into App Information, License Agreement.
   - **Play Console:** App content, Privacy policy is `/privacy/`. In the Data safety form, the delete account URL is `/delete-account/`.
   - **Razorpay:** Account & Settings, Business website details. Give the home page as the website, then each policy page: contact is `/support/`, and the others are `/terms/`, `/privacy/`, `/refunds/`, `/shipping/` and `/pricing/`.
6. **Set `EXPO_PUBLIC_SITE_URL`** for the app's store builds, so its links point here ([the app's README](../mobile/README.md#before-the-first-store-build)).

### The details to fill in

| Key | What it is |
|---|---|
| `companyName` | The company's legal name, as on its certificate of incorporation and GST registration. |
| `address` | The registered address. |
| `supportEmail` | Where members write. It's on every page. |
| `supportPhone` | A customer-care number. India's Consumer Protection (E-Commerce) Rules, 2020 ask for one on the site. |
| `grievanceOfficer`, `grievanceEmail` | The person who handles complaints, under both those rules and the data protection law, and their email. A founder is fine, and the email can be a role address such as `grievance@`. The pages promise an acknowledgement within 48 hours and an answer within a month. |
| `siteUrl` | The site's own address, for the sitemap. |
| `city` | The city whose courts hear disputes, usually where the company is registered. |
| `emailProvider` | The company behind the API's SMTP settings, which sends sign-in codes and invoices. |
| `hostingRegion` | Where the servers are, for example "India". |
| `backupDays` | How long database backups are kept before they're overwritten. |
| `effectiveDate` | The date the policies start to apply, written out, for example "1 December 2026". |
| `refundWindowDays` | The number of days a course bought on the website can be refunded, no questions asked. Keep it the same as the refund window in admin's Money settings: teachers' shares are paid only after that window, so a longer promise here would refund money already paid out. |
| `appStoreUrl`, `playStoreUrl` | The store listings, once the apps are out. Until then the home page says "Coming soon". Optional. |
| `webAppUrl` | The members' web app, if it's online, which is where website purchases happen. The home page links to it. Optional. |

### When a policy changes

Both the privacy policy and the terms promise to tell members before a change that matters takes effect. So:
1. Send a notification from admin, or an email, first.
2. Then change the page and `effectiveDate`, and rebuild.

## Build and check

```bash
cd apps/site
npm install
npm run build            # dist/, with anything missing highlighted in yellow on the pages
npm run build:release    # refuses to build until every detail is filled in
npm test                 # builds with sample details, then checks every link, every #section, and that nothing loads from elsewhere
python3 -m http.server 8088 -d dist    # then open http://localhost:8088
```

CI runs the tests and the build on every push that touches `apps/site`. Once `site.config.json` is filled in, switch CI's build step to `build:release`, so a gap can't slip back in.

## Serving it

Copy `dist/` to the app VPS, for example to `/srv/embodha-site`, and add this to the Caddyfile, with your domain in place of `example.com`:

```
example.com {
	root * /srv/embodha-site
	file_server
	header {
		Content-Security-Policy "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
	}
	@static path /fonts/* /styles.css /favicon.svg
	header @static Cache-Control "public, max-age=604800"
	handle_errors {
		@notFound expression {err.status_code} == 404
		handle @notFound {
			rewrite * /404.html
			file_server
		}
	}
}

www.example.com {
	redir https://example.com{uri} permanent
}
```

The security policy is strict because the pages need nothing else: no scripts, no inline styles, no images from elsewhere. If a page ever gains one, the browser will block it, and that's the cue to update the policy, not to remove it.

The one-tap sign-in link in Embodha's emails goes to the API's `WEB_URL`, which is the members' web app. It doesn't come here. The page addresses above are what the app links to, so keep them if the pages are ever renamed.
