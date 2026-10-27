import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { promises as dns } from 'node:dns';
import { BetaHealthService } from '../beta/beta.module';
import { MediaService } from '../media/media.service';
import { audit } from '../common/audit';
import { fail } from '../common/errors';
import { BUSINESS_TIME_ZONE } from '../common/month';
import { readSetting } from '../common/settings';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import {
  chapters,
  courses,
  instructorPlans,
  InvoiceSeller,
  launchSignoffs,
  mediaAssets,
  payments,
  settings,
  storeProducts,
  users,
  WEBHOOK_SOURCES,
  webhookReceipts,
} from '../db/schema';
import { AppleStoreClient } from '../money/apple-store.client';
import { DEFAULT_SELLER, gstinProblem } from '../money/gst';

export type CheckStatus = 'done' | 'todo' | 'waiting';

export interface Check {
  key: string;
  /** What has to be true, said plainly. */
  title: string;
  /** done; todo: something to do; waiting: nothing to do but wait (data to collect, a store's review). */
  status: CheckStatus;
  /** What the server found, or what's missing and how to put it right. */
  detail: string;
  /** Launch waits for it. A few are worth doing but don't hold launch up. */
  blocking: boolean;
  /** The admin page where it's put right. */
  page?: { to: string; label: string };
  /** The server settings it reads, for whoever runs the server. */
  env?: string[];
  /** A button the page offers next to it. */
  action?: 'apple_test' | 'video_downloads';
  /** Set on the gates only a person can confirm: who signed it off, or null while nobody has. */
  signoff?: { by: string | null; at: string; note: string | null } | null;
}

export interface Section {
  key: string;
  title: string;
  checks: Check[];
}

/**
 * The launch gates the server can't see for itself. Someone with the super admin role signs each one off, with a
 * note if they like, and the checklist keeps who and when.
 */
export const SIGNOFFS = [
  {
    key: 'accountant',
    title: 'Your accountant has been through a month of the books',
    detail: "The GST page and its two CSVs, the SAC printed on invoices, TDS on instructors' payouts, and GST on sales in the apps.",
  },
  {
    key: 'lawyer',
    title: 'A lawyer has read the terms, privacy policy and refund policy',
    detail: 'The instructor agreement too, and every instructor has signed it.',
  },
  {
    key: 'store_fees',
    title: "Enrolled for both stores' 15% rate",
    detail:
      "Apple's Small Business Program, and Play's 15% tier on the Associated developer accounts page. Without them a course sold in the apps costs 30%, not the 15% the books expect.",
  },
  {
    key: 'store_listings',
    title: 'The store listings are filled in',
    detail: 'Screenshots, description, App Privacy and Data safety, age rating, and the App Review sign-in in the review notes.',
  },
  {
    key: 'device_check',
    title: 'The device check passed on a low-end Android phone',
    detail: 'Cold start, scrolling, video start on mobile data, an hour of use, and the minified build: the "Device check" in the README.',
  },
  {
    key: 'mail_inboxes',
    title: 'A sign-in code reached a Gmail and an Outlook inbox',
    detail: 'From the real sending address, not in spam, and with DKIM passing (Gmail shows it under "Show original").',
  },
  {
    key: 'backups',
    title: 'A backup has been restored',
    detail: "Last night's dump restored into a scratch database, and the WAL archive reaching off-site storage.",
  },
  {
    key: 'pen_test',
    title: 'The outside penetration test is done',
    detail: 'Its findings fixed, or accepted in writing (SECURITY.md).',
  },
] as const;
export type SignoffKey = (typeof SIGNOFFS)[number]['key'];

const PAGES = {
  courses: { to: '/admin/courses', label: 'Courses' },
  catalogue: { to: '/admin/catalogue', label: 'Catalogue' },
  store: { to: '/admin/store-products', label: 'Store products' },
  payments: { to: '/admin/payments', label: 'Payments' },
  money: { to: '/admin/money-settings', label: 'Money settings' },
  beta: { to: '/admin/beta', label: 'Beta health' },
  reconciliation: { to: '/admin/reconciliation', label: 'Reconciliation' },
} as const;

/** The public site's pages (apps/site), as its README lists them. */
const SITE_PAGES = [
  ['/', 'home'],
  ['/pricing/', 'pricing'],
  ['/privacy/', 'privacy'],
  ['/terms/', 'terms'],
  ['/refunds/', 'refunds'],
  ['/shipping/', 'shipping'],
  ['/support/', 'support'],
  ['/delete-account/', 'delete your account'],
] as const;

/** What the outside checks remember, so the Overview and a quick reload don't fetch everything again. */
const OUTSIDE_TTL_MS = 2 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "22 Oct 2026, 22:42", India time. */
export function when(at: Date | string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** "A", "A and B", "A, B and C". */
export function list(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "A", "A or B", "A, B or C". */
export function listOr(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Problems that may have commas of their own, as one sentence: "First one; second one; third one." */
const sentence = (parts: string[]) => {
  const text = parts.join('; ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Probe {
  status: number | null;
  type: string;
  body: string;
  location: string | null;
  error: string | null;
}

/**
 * Everything that has to be in place before launch, in one list: what the server can check for itself (settings,
 * keys, webhooks heard from, the catalogue, store products, the website's pages, the sign-in link files, the launch
 * bars from Beta health) and the few gates only a person can sign off.
 */
@Injectable()
export class LaunchService {
  private readonly outside = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly beta: BetaHealthService,
    private readonly apple: AppleStoreClient,
    private readonly media: MediaService,
  ) {}

  async checklist(fresh = false) {
    if (fresh) this.outside.clear();
    const [catalogue, website, apps, money, media, links, bars, signed] = await Promise.all([
      this.catalogueChecks(),
      this.websiteChecks(),
      this.appChecks(),
      this.moneyChecks(),
      this.mediaChecks(),
      this.linkChecks(),
      this.barChecks(),
      this.signoffChecks(),
    ]);
    const sections: Section[] = [
      { key: 'catalogue', title: 'Courses', checks: catalogue },
      { key: 'website', title: 'Selling on the website', checks: website },
      { key: 'apps', title: 'Selling in the apps', checks: apps },
      { key: 'money', title: 'Money and invoices', checks: money },
      { key: 'media', title: 'Video, audio and email', checks: media },
      { key: 'links', title: 'The website and the sign-in link', checks: links },
      { key: 'bars', title: 'The launch bars, over the last 14 days', checks: bars },
      { key: 'signoffs', title: 'Only a person can check these', checks: signed },
    ];
    const all = sections.flatMap((section) => section.checks);
    const left = all.filter((check) => check.blocking && check.status !== 'done').length;
    return {
      ready: left === 0,
      left,
      counts: { done: all.filter((c) => c.status === 'done').length, todo: all.filter((c) => c.status === 'todo').length, waiting: all.filter((c) => c.status === 'waiting').length },
      total: all.length,
      sections,
      checkedAt: new Date(),
    };
  }

  /* ------------------------------------------------------------ Courses */

  private async catalogueChecks(): Promise<Check[]> {
    const rows = <T>(query: ReturnType<typeof sql>) => this.db.execute(query).then((result) => result.rows as T[]);
    const [[free], categories, broken, [live]] = await Promise.all([
      this.db.select({ title: courses.title, status: courses.status }).from(courses).where(eq(courses.isFree, true)).limit(1),
      rows<{ name: string; on_sale: number }>(sql`
        select c.name, (count(co.id) filter (where co.status = 'published' and not co.is_free and co.price_point_id is not null))::int as on_sale
        from categories c
        left join topics t on t.category_id = c.id
        left join courses co on co.topic_id = t.id
        where c.active
        group by c.id, c.name, c.sort
        order by c.sort, c.name`),
      rows<{ title: string; missing: number; unready: number; stand_in: number }>(sql`
        select co.title,
          (count(*) filter (where m.id is null))::int as missing,
          (count(*) filter (where m.id is not null and m.status <> 'ready'))::int as unready,
          (count(*) filter (where m.status = 'ready' and m.provider = 'dev_sample'))::int as stand_in
        from courses co
        join chapters ch on ch.course_id = co.id
        left join media_assets m on m.id = ch.media_asset_id
        where co.status = 'published'
        group by co.id, co.title
        having count(*) filter (where m.id is null or m.status <> 'ready' or m.provider = 'dev_sample') > 0
        order by co.title`),
      this.db.select({ n: count() }).from(courses).where(eq(courses.status, 'published')),
    ]);

    const freeWord = { draft: 'still a draft', in_review: 'waiting for review', archived: 'archived', published: 'live' } as const;
    const empty = categories.filter((c) => !c.on_sale).map((c) => c.name);
    return [
      {
        key: 'free_course',
        title: 'The free course is live',
        blocking: true,
        page: PAGES.courses,
        ...(free?.status === 'published'
          ? { status: 'done' as const, detail: `${free.title} is free for everyone.` }
          : free
            ? { status: 'todo' as const, detail: `${free.title} is the free course, but it's ${freeWord[free.status]}.` }
            : { status: 'todo' as const, detail: 'No course is the free one yet. Pick it on the Courses page.' }),
      },
      {
        key: 'categories',
        title: 'Every category on show has a course on sale',
        blocking: true,
        page: PAGES.catalogue,
        ...(!categories.length
          ? { status: 'todo' as const, detail: 'No categories are on show in the app.' }
          : empty.length
            ? {
                status: 'todo' as const,
                detail: `Nothing on sale yet in ${list(empty)}. Publish a paid course there, or hide the category on the Catalogue page until one's ready.`,
              }
            : { status: 'done' as const, detail: `All ${categories.length} categories on show have courses on sale: ${categories.map((c) => `${c.name} ${c.on_sale}`).join(', ')}.` }),
      },
      {
        key: 'chapters_play',
        title: 'Every chapter of every live course plays',
        blocking: true,
        page: PAGES.courses,
        ...(broken.length
          ? {
              status: 'todo' as const,
              detail: `Members would hit chapters that won't play. ${[
                ['missing', 'With no video or audio'],
                ['unready', 'Still processing, or failed'],
                ['stand_in', "On the local stand-in video, which production won't serve"],
              ]
                .map(([field, what]) => {
                  const courses = broken.filter((course) => course[field as 'missing' | 'unready' | 'stand_in']);
                  return courses.length ? `${what}: ${list(courses.map((course) => `${course.title} (${course[field as 'missing' | 'unready' | 'stand_in']})`))}.` : null;
                })
                .filter(Boolean)
                .join(' ')}`,
            }
          : { status: 'done' as const, detail: `Every chapter of the ${plural(live.n, 'live course')} has its video or audio ready.` }),
      },
    ];
  }

  /* ------------------------------------------------------------ The website */

  private async websiteChecks(): Promise<Check[]> {
    const env = this.env;
    const receipts = await this.receipts();
    const missing = (
      [
        ['RAZORPAY_KEY_ID', env.RAZORPAY_KEY_ID],
        ['RAZORPAY_KEY_SECRET', env.RAZORPAY_KEY_SECRET],
        ['RAZORPAY_WEBHOOK_SECRET', env.RAZORPAY_WEBHOOK_SECRET],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const heard = receipts.razorpay;
    return [
      {
        key: 'razorpay_keys',
        title: 'Razorpay takes real payments',
        blocking: true,
        env: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
        ...(missing.length
          ? { status: 'todo' as const, detail: `${list(missing)} ${missing.length === 1 ? "isn't" : "aren't"} set, so the website can't take payments.` }
          : env.RAZORPAY_KEY_ID.startsWith('rzp_test_')
            ? {
                status: 'todo' as const,
                detail: "These are test-mode keys: checkout works, but no real money moves. For launch, put in the live keys, and the secret of a webhook made in live mode.",
              }
            : { status: 'done' as const, detail: 'Live keys are set.' }),
      },
      {
        key: 'razorpay_webhook',
        title: "Razorpay's webhook reaches Embodha",
        blocking: true,
        page: PAGES.payments,
        ...(heard
          ? { status: 'done' as const, detail: `The last one came in on ${when(heard.lastAt)}: ${heard.lastEvent ?? 'an event'}. ${plural(heard.received, 'webhook')} so far.` }
          : {
              status: 'todo' as const,
              detail:
                "Nothing yet. In Razorpay's dashboard, under Webhooks, point one at /v1/webhooks/razorpay on this API with the events the README lists. The next test payment shows up here.",
            }),
      },
    ];
  }

  /* ------------------------------------------------------------ The apps */

  private async appChecks(): Promise<Check[]> {
    const env = this.env;
    const [receipts, asked, products, tests] = await Promise.all([
      this.receipts(),
      readSetting<{ at: string } | null>(this.db, 'launch_apple_test', null),
      this.storeProductGaps(),
      this.db
        .select({ channel: payments.channel, at: sql<string>`max(${payments.capturedAt})` })
        .from(payments)
        .where(and(eq(payments.isTest, true), inArray(payments.channel, ['apple', 'google'])))
        .groupBy(payments.channel),
    ]);

    const apple = receipts.apple;
    const sandbox = receipts.apple_sandbox;
    const askedAndSilent = asked && (!apple || apple.lastAt < new Date(asked.at));
    const googleMissing = (
      [
        ['GOOGLE_PLAY_SERVICE_ACCOUNT', env.GOOGLE_PLAY_SERVICE_ACCOUNT],
        ['GOOGLE_PLAY_RTDN_SECRET', env.GOOGLE_PLAY_RTDN_SECRET],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const testAt = (channel: 'apple' | 'google') => tests.find((t) => t.channel === channel)?.at ?? null;

    return [
      {
        key: 'apple_keys',
        title: 'The iOS app can sell',
        blocking: true,
        env: ['APPLE_ISSUER_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'],
        ...(this.apple.ready
          ? { status: 'done' as const, detail: 'The In-App Purchase key is set, so every purchase in the iOS app is checked with Apple.' }
          : { status: 'todo' as const, detail: "There's no In-App Purchase key from App Store Connect, so the iOS app can't sell yet." }),
      },
      {
        key: 'apple_notifications',
        title: "Apple's notifications reach Embodha",
        blocking: true,
        action: this.apple.ready ? 'apple_test' : undefined,
        ...(apple && !askedAndSilent
          ? { status: 'done' as const, detail: `The last one from the production server came in on ${when(apple.lastAt)}: ${apple.lastEvent ?? 'a notification'}.` }
          : askedAndSilent
            ? {
                status: 'todo' as const,
                detail: `Apple was asked for a test on ${when(asked.at)}, and nothing has come from its production server since. In App Store Connect, App Information, the production URL for App Store Server Notifications should be /v1/webhooks/apple on this API, version 2.${sandbox ? ` The sandbox URL works: its last notification came on ${when(sandbox.lastAt)}.` : ''}`,
              }
            : {
                status: 'todo' as const,
                detail: `Nothing from Apple's production server yet.${sandbox ? ` The sandbox one got through on ${when(sandbox.lastAt)}.` : ''} Set the production URL in App Store Connect, App Information${
                  this.apple.ready ? ', then ask Apple for a test' : ". Once the In-App Purchase key is in, this page can ask Apple for a test"
                }.`,
              }),
      },
      {
        key: 'google_keys',
        title: 'The Android app can sell',
        blocking: true,
        env: ['GOOGLE_PLAY_SERVICE_ACCOUNT', 'GOOGLE_PLAY_RTDN_SECRET'],
        ...(googleMissing.length
          ? { status: 'todo' as const, detail: `${list(googleMissing)} ${googleMissing.length === 1 ? "isn't" : "aren't"} set, so Play purchases can't be checked with Google.` }
          : { status: 'done' as const, detail: 'The service account and the notification secret are set.' }),
      },
      {
        key: 'google_notifications',
        title: "Google Play's notifications reach Embodha",
        blocking: true,
        ...(receipts.google
          ? { status: 'done' as const, detail: `The last one came in on ${when(receipts.google.lastAt)}: ${receipts.google.lastEvent ?? 'a notification'}.` }
          : {
              status: 'todo' as const,
              detail: 'Nothing yet. In Play Console, Monetization setup, press "Send test notification": it should land here within a minute.',
            }),
      },
      { ...products, key: 'store_products', title: 'Everything on sale is live in both stores', blocking: true, page: PAGES.store },
      {
        key: 'test_purchases',
        title: 'A test purchase has come through from each store',
        blocking: true,
        page: PAGES.payments,
        ...(testAt('apple') && testAt('google')
          ? { status: 'done' as const, detail: `TestFlight's last came in on ${when(testAt('apple')!)}, and a Play licence tester's on ${when(testAt('google')!)}.` }
          : {
              status: 'todo' as const,
              detail: `${testAt('apple') ? `TestFlight's came in on ${when(testAt('apple')!)}` : 'Nothing from TestFlight yet'}; ${testAt('google') ? `a Play licence tester's came in on ${when(testAt('google')!)}` : 'nothing from a Play licence tester yet'}. Buy a course with each: it should unlock and show on Payments as a test.`,
            }),
      },
    ];
  }

  /** Paid courses on sale and switched-on subscriptions, against the store products linked to them. */
  private async storeProductGaps(): Promise<Pick<Check, 'status' | 'detail'>> {
    const [onSale, plans, products] = await Promise.all([
      this.db
        .select({ id: courses.id, name: courses.title })
        .from(courses)
        .where(and(eq(courses.status, 'published'), eq(courses.isFree, false), sql`${courses.pricePointId} is not null`)),
      this.db
        .select({ id: instructorPlans.instructorId, name: sql<string>`(select display_name from instructors i where i.id = ${instructorPlans.instructorId})` })
        .from(instructorPlans)
        .where(eq(instructorPlans.enabled, true)),
      this.db.select().from(storeProducts),
    ]);
    const owners = [...onSale.map((c) => ({ ...c, type: 'course' as const })), ...plans.map((p) => ({ ...p, name: `${p.name}'s subscription`, type: 'instructor_plan' as const }))];
    if (!owners.length) return { status: 'waiting', detail: 'Nothing paid is on sale yet, so there are no products to check.' };
    const STORE = { apple: 'the App Store', google: 'Google Play' } as const;
    const gaps: { text: string; waiting: boolean }[] = [];
    for (const owner of owners) {
      for (const store of ['apple', 'google'] as const) {
        const product = products.find((p) => p.ownerType === owner.type && p.ownerId === owner.id && p.store === store);
        if (product?.status === 'live') continue;
        const state = !product ? 'no product' : product.status === 'in_review' ? 'in review' : product.status === 'pending' ? 'being made' : product.status === 'failed' ? 'failed' : 'off sale';
        gaps.push({ text: `${owner.name} on ${STORE[store]} (${state})`, waiting: product?.status === 'in_review' || product?.status === 'pending' });
      }
    }
    const total = owners.length * 2;
    if (!gaps.length) {
      return { status: 'done', detail: `All ${total} products are live: ${plural(onSale.length, 'course')} and ${plural(plans.length, 'subscription')}, in both stores.` };
    }
    const shown = gaps.slice(0, 6).map((gap) => gap.text);
    const more = gaps.length > shown.length ? `, and ${gaps.length - shown.length} more` : '';
    if (gaps.every((gap) => gap.waiting)) return { status: 'waiting', detail: `${total - gaps.length} of ${total} live. Waiting on the stores: ${list(shown)}${more}.` };
    return { status: 'todo', detail: `${total - gaps.length} of ${total} live. Not yet: ${list(shown)}${more}.` };
  }

  /* ------------------------------------------------------------ Money */

  private async moneyChecks(): Promise<Check[]> {
    const [seller, noteAbroad] = await Promise.all([
      readSetting<InvoiceSeller>(this.db, 'invoice_seller', DEFAULT_SELLER).then((s) => ({ ...DEFAULT_SELLER, ...s })),
      readSetting<string>(this.db, 'invoice_note_abroad', ''),
    ]);
    const gaps = [
      !seller.name?.trim() ? 'the legal name' : null,
      !seller.address?.trim() ? 'the address' : null,
      !seller.gstin?.trim() ? 'the GSTIN' : gstinProblem(seller.gstin) ? 'a GSTIN that checks out' : null,
    ].filter((gap): gap is string => Boolean(gap));
    // The SAC is optional on invoices to consumers while turnover is under ₹5 crore, so it's mentioned, not required.
    const sac = seller.sac?.trim() ? `, SAC ${seller.sac.trim()}.` : ". No SAC is printed, which is fine on sales to members while turnover is under ₹5 crore; your accountant can confirm.";
    return [
      {
        key: 'seller',
        title: "Invoices carry the seller's details",
        blocking: true,
        page: PAGES.money,
        ...(gaps.length
          ? { status: 'todo' as const, detail: `Website invoices are missing ${list(gaps)}. Every invoice keeps the details it was issued with, so set these before the first real sale.` }
          : { status: 'done' as const, detail: `${seller.name}, GSTIN ${seller.gstin}${sac}` }),
      },
      {
        key: 'lut',
        title: 'Export invoices carry the LUT',
        blocking: true,
        page: PAGES.money,
        ...(noteAbroad.trim()
          ? { status: 'done' as const, detail: `Invoices to buyers abroad end with: "${noteAbroad.trim().length > 90 ? `${noteAbroad.trim().slice(0, 90)}…` : noteAbroad.trim()}"` }
          : {
              status: 'todo' as const,
              detail: "Invoices to buyers abroad have no footnote. An export without IGST has to name the Letter of Undertaking it's made under: add its ARN in Money settings.",
            }),
      },
      {
        key: 'finance_inbox',
        title: 'Finance hears about money that doesn’t match',
        blocking: false,
        env: ['FINANCE_EMAIL'],
        page: PAGES.reconciliation,
        ...(this.env.FINANCE_EMAIL
          ? { status: 'done' as const, detail: `The nightly money check writes to ${this.env.FINANCE_EMAIL}.` }
          : { status: 'todo' as const, detail: "FINANCE_EMAIL isn't set, so the nightly money check can only leave its findings on the Reconciliation page." }),
      },
    ];
  }

  /* ------------------------------------------------------------ Video, audio and email */

  private async mediaChecks(): Promise<Check[]> {
    const env = this.env;
    const [receipts, [audio], mail, [videos]] = await Promise.all([
      this.receipts(),
      this.db
        .select({ n: count() })
        .from(chapters)
        .innerJoin(courses, eq(courses.id, chapters.courseId))
        .where(and(eq(chapters.type, 'audio'), ne(courses.status, 'archived'))),
      this.mailCheck(),
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          saveable: sql<number>`(count(*) filter (where cardinality(${mediaAssets.downloadHeights}) > 0))::int`,
        })
        .from(chapters)
        .innerJoin(courses, eq(courses.id, chapters.courseId))
        .innerJoin(mediaAssets, eq(mediaAssets.id, chapters.mediaAssetId))
        .where(and(ne(courses.status, 'archived'), eq(mediaAssets.provider, 'bunny_stream'), eq(mediaAssets.status, 'ready'))),
    ]);
    const unsaveable = videos.total - videos.saveable;
    const unset = (names: (keyof Env)[]) => names.filter((name) => !env[name]);
    const videoMissing = unset(['BUNNY_STREAM_LIBRARY_ID', 'BUNNY_STREAM_API_KEY', 'BUNNY_STREAM_CDN_HOST', 'BUNNY_STREAM_TOKEN_KEY', 'BUNNY_WEBHOOK_SECRET']);
    const audioMissing = unset(['BUNNY_STORAGE_ZONE', 'BUNNY_STORAGE_PASSWORD', 'BUNNY_AUDIO_CDN_HOST', 'BUNNY_AUDIO_TOKEN_KEY']);
    return [
      {
        key: 'bunny_video',
        title: 'Paid video plays on signed links',
        blocking: true,
        env: ['BUNNY_STREAM_LIBRARY_ID', 'BUNNY_STREAM_API_KEY', 'BUNNY_STREAM_CDN_HOST', 'BUNNY_STREAM_TOKEN_KEY', 'BUNNY_WEBHOOK_SECRET'],
        ...(videoMissing.length
          ? { status: 'todo' as const, detail: `${list(videoMissing)} ${videoMissing.length === 1 ? "isn't" : "aren't"} set.` }
          : { status: 'done' as const, detail: 'Uploads go to Bunny Stream, and paid chapters play on links that expire.' }),
      },
      {
        key: 'bunny_webhook',
        title: "Bunny's webhook reaches Embodha",
        blocking: true,
        ...(receipts.bunny
          ? { status: 'done' as const, detail: `The last one came in on ${when(receipts.bunny.lastAt)}: ${receipts.bunny.lastEvent ?? 'a video update'}.` }
          : {
              status: 'todo' as const,
              detail: "Nothing yet. In the Stream library's settings, set the webhook to /v1/webhooks/video?secret=… on this API. The next upload that finishes processing shows up here.",
            }),
      },
      {
        key: 'bunny_audio',
        title: 'Audio chapters have somewhere to live',
        blocking: audio.n > 0,
        env: ['BUNNY_STORAGE_ZONE', 'BUNNY_STORAGE_PASSWORD', 'BUNNY_AUDIO_CDN_HOST', 'BUNNY_AUDIO_TOKEN_KEY'],
        ...(!audio.n
          ? { status: 'done' as const, detail: 'No course has an audio chapter yet, so there is nothing to set up.' }
          : audioMissing.length
            ? { status: 'todo' as const, detail: `${plural(audio.n, 'audio chapter')} in the catalogue, but ${list(audioMissing)} ${audioMissing.length === 1 ? "isn't" : "aren't"} set.` }
            : { status: 'done' as const, detail: `${plural(audio.n, 'audio chapter')}, stored on Bunny and played on links that expire.` }),
      },
      {
        key: 'video_downloads',
        title: 'Videos can be saved for offline viewing',
        blocking: false,
        ...(!videos.total
          ? {
              status: 'waiting' as const,
              detail:
                "No video is up on Bunny yet. Before the first upload, switch on MP4 fallback in the Stream library's Encoding settings: Bunny only makes the copy the apps download for videos uploaded after that.",
            }
          : !unsaveable
            ? { status: 'done' as const, detail: `${videos.total === 1 ? 'The one video has' : `All ${videos.total} videos have`} a copy the apps can save.` }
            : {
                status: 'todo' as const,
                action: 'video_downloads' as const,
                detail: `${unsaveable} of ${plural(videos.total, 'video')} ${unsaveable === 1 ? 'has' : 'have'} no copy the apps can save, so ${unsaveable === 1 ? 'it streams' : 'they stream'} but can't be downloaded. Bunny makes one only for videos uploaded while MP4 fallback is on in the Stream library's Encoding settings. Re-encode older ones from Bunny's dashboard, then look again here.`,
              }),
      },
      { ...mail, key: 'email', title: 'Sign-in codes go out from your own domain', blocking: true, env: ['MAIL_TRANSPORT', 'MAIL_FROM', 'SMTP_HOST'] },
      {
        key: 'review_account',
        title: 'App Review can sign in',
        blocking: true,
        env: ['REVIEW_ACCOUNT_EMAIL', 'REVIEW_ACCOUNT_CODE'],
        ...(env.REVIEW_ACCOUNT_EMAIL
          ? { status: 'done' as const, detail: `Reviewers sign in as ${env.REVIEW_ACCOUNT_EMAIL} with its fixed code. Put both in the review notes in App Store Connect and Play Console.` }
          : {
              status: 'todo' as const,
              detail: "Reviewers can't receive a sign-in code by email, and both stores reject an app they can't get into. Set the review account and its six-digit code.",
            }),
      },
      {
        key: 'feedback_inbox',
        title: 'Feedback from the app reaches an inbox',
        blocking: false,
        env: ['FEEDBACK_EMAIL'],
        ...(env.FEEDBACK_EMAIL
          ? { status: 'done' as const, detail: `It goes to ${env.FEEDBACK_EMAIL}, as well as the Feedback page.` }
          : { status: 'todo' as const, detail: "FEEDBACK_EMAIL isn't set, so feedback only collects on the Feedback page." }),
      },
    ];
  }

  /** SMTP, a real sending address, and SPF and DMARC records on its domain. DKIM needs a selector, so a person checks it. */
  private async mailCheck(): Promise<Pick<Check, 'status' | 'detail'>> {
    const env = this.env;
    const from = /<([^>]+)>/.exec(env.MAIL_FROM)?.[1] ?? env.MAIL_FROM.trim();
    const domain = from.split('@')[1]?.toLowerCase() ?? '';
    const placeholder = !domain || /(^|\.)(example\.(com|org|net)|localhost|local|test|invalid)$/.test(domain);
    const [spf, dmarc] = placeholder ? [null, null] : await Promise.all([this.txt(domain), this.txt(`_dmarc.${domain}`)]);
    const problems = [
      env.MAIL_TRANSPORT !== 'smtp' || !env.SMTP_HOST ? 'mail goes to the console, not out over SMTP (MAIL_TRANSPORT and SMTP_HOST)' : null,
      placeholder ? `the sending address is ${from || 'not set'} (MAIL_FROM)` : null,
      !placeholder && spf === null ? `${domain}'s DNS couldn't be looked up` : null,
      !placeholder && spf && !spf.some((r) => r.toLowerCase().startsWith('v=spf1')) ? `${domain} has no SPF record` : null,
      !placeholder && spf && dmarc && !dmarc.some((r) => r.toLowerCase().startsWith('v=dmarc1')) ? `there's no DMARC record at _dmarc.${domain}` : null,
    ].filter((p): p is string => Boolean(p));
    if (problems.length) return { status: 'todo', detail: `${sentence(problems)} A code that lands in spam is a member who can't sign in.` };
    return { status: 'done', detail: `Codes go out over SMTP from ${from}, and ${domain} has SPF and DMARC records. DKIM is for a person to check: see the sign-off below.` };
  }

  /* ------------------------------------------------------------ The website and the sign-in link */

  private async linkChecks(): Promise<Check[]> {
    const env = this.env;
    const site = env.SITE_URL?.replace(/\/+$/, '') ?? null;
    const [pages, refundDays, aasa, assetlinks] = await Promise.all([
      site ? Promise.all(SITE_PAGES.map(async ([path, name]) => ({ path, name, probe: await this.probe(`${site}${path}`) }))) : Promise.resolve(null),
      readSetting<number>(this.db, 'refund_window_days', 7),
      this.probe(`${env.WEB_URL.replace(/\/+$/, '')}/.well-known/apple-app-site-association`, false),
      this.probe(`${env.WEB_URL.replace(/\/+$/, '')}/.well-known/assetlinks.json`, false),
    ]);

    const pageProblem = (probe: Probe) =>
      probe.error ?? (probe.status !== 200 ? `answered ${probe.status}` : !probe.type.includes('text/html') ? `answered with ${probe.type || 'no content type'}` : null);
    const broken = pages?.filter((page) => pageProblem(page.probe)) ?? [];
    const refunds = pages?.find((page) => page.path === '/refunds/');
    const promised = refunds && !pageProblem(refunds.probe) ? /within\s+(\d+)\s+days/i.exec(refunds.probe.body.replace(/<[^>]+>/g, ' '))?.[1] : undefined;

    return [
      {
        key: 'site_pages',
        title: "The website's pages are up",
        blocking: true,
        env: ['SITE_URL'],
        ...(!site
          ? { status: 'todo' as const, detail: "SITE_URL isn't set, so the website's pages can't be checked from here. Set it to the public site's address." }
          : broken.length
            ? { status: 'todo' as const, detail: `${list(broken.map((page) => `${page.path} ${pageProblem(page.probe)}`))}. The stores and Razorpay check these pages.` }
            : { status: 'done' as const, detail: `All ${SITE_PAGES.length} pages answer at ${site}: ${list(SITE_PAGES.map(([, name]) => name))}.` }),
      },
      {
        key: 'refund_window',
        title: "The website's refund promise matches the books",
        blocking: true,
        page: PAGES.money,
        ...(promised === undefined
          ? {
              status: 'todo' as const,
              detail: site && refunds && !pageProblem(refunds.probe) ? "The refunds page doesn't say how many days a refund is open for." : 'This can be checked once the refunds page answers.',
            }
          : Number(promised) === refundDays
            ? { status: 'done' as const, detail: `The refunds page promises ${promised} days, the same as the refund window in Money settings.` }
            : {
                status: 'todo' as const,
                detail: `The refunds page promises ${promised} days, but the refund window in Money settings is ${refundDays}. Change refundWindowDays in the site's config, or the setting, so they agree.`,
              }),
      },
      { ...this.linkFiles(aasa, assetlinks), key: 'link_files', title: 'The sign-in link opens the app', blocking: true, env: ['WEB_URL'] },
    ];
  }

  /** iOS and Android only open the one-tap sign-in link in the app if the members' web app vouches for it, over https. */
  private linkFiles(aasa: Probe, assetlinks: Probe): Pick<Check, 'status' | 'detail'> {
    const env = this.env;
    const host = env.WEB_URL.replace(/\/+$/, '');
    const problems: string[] = [];
    if (!host.startsWith('https://')) problems.push(`WEB_URL is ${host}, and phones only open https links in an app`);
    const json = (probe: Probe) => {
      try {
        return probe.status === 200 ? (JSON.parse(probe.body) as unknown) : null;
      } catch {
        return null;
      }
    };
    // A single-page app's fallback answers every path with its index.html, link files included: the usual mistake.
    const page = (probe: Probe) => probe.status === 200 && probe.type.includes('text/html');
    const apple = json(aasa) as { applinks?: { details?: { appIDs?: string[]; appID?: string }[] } } | null;
    const appleIds = apple?.applinks?.details?.flatMap((d) => d.appIDs ?? (d.appID ? [d.appID] : [])) ?? [];
    const AASA = '/.well-known/apple-app-site-association';
    if (aasa.status !== 200) problems.push(`${AASA} ${aasa.error ?? (aasa.status && aasa.status >= 300 && aasa.status < 400 ? "redirects, and Apple won't follow it" : `answered ${aasa.status}`)}`);
    else if (page(aasa)) problems.push(`${AASA} answers with a web page, not the file: the web app's fallback is catching it`);
    else if (!appleIds.some((id) => id.endsWith(`.${env.APPLE_BUNDLE_ID}`))) problems.push(`the Apple file doesn't name ${env.APPLE_BUNDLE_ID}`);
    const android = json(assetlinks) as { target?: { package_name?: string; sha256_cert_fingerprints?: string[] } }[] | null;
    const target = Array.isArray(android) ? android.find((entry) => entry.target?.package_name === env.GOOGLE_PLAY_PACKAGE_NAME) : undefined;
    if (assetlinks.status !== 200) problems.push(`/.well-known/assetlinks.json ${assetlinks.error ?? `answered ${assetlinks.status}`}`);
    else if (page(assetlinks)) problems.push('/.well-known/assetlinks.json answers with a web page too');
    else if (!target?.target?.sha256_cert_fingerprints?.length) problems.push(`the Android file doesn't vouch for ${env.GOOGLE_PLAY_PACKAGE_NAME}`);
    if (problems.length) {
      const files = problems.some((problem) => problem.includes('/.well-known/') || problem.includes(' file '));
      return {
        status: 'todo',
        detail: `${sentence(problems)} Until then the sign-in email opens the browser instead of the app.${files ? ' "npm run web:release" in apps/mobile writes both files.' : ''}`,
      };
    }
    const ids = [...new Set([env.APPLE_BUNDLE_ID, env.GOOGLE_PLAY_PACKAGE_NAME])];
    return { status: 'done', detail: `${host} vouches for the app (${list(ids)}), so the sign-in email opens it on iPhone and Android.` };
  }

  /* ------------------------------------------------------------ The launch bars */

  private async barChecks(): Promise<Check[]> {
    const report = await this.beta.report(14);
    const { crashFree, videoStart, switchOff, reconciliation: money } = report.bars;
    const percent = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`);

    // Money: every channel and both currencies, nothing late, nothing that doesn't match.
    const late = money.due - money.reconciled;
    const quiet = (['razorpay', 'google', 'apple'] as const).filter((c) => !money.channels[c].reconciled).map((c) => ({ razorpay: 'the website', google: 'Google Play', apple: 'the App Store' })[c]);
    const currencies = (['INR', 'USD'] as const).filter((c) => !money.currencies.includes(c)).map((c) => (c === 'INR' ? 'rupee' : 'dollar'));
    const moneyGaps = [
      late ? `${plural(late, 'sale')} the reports should have had` : null,
      money.problems ? `${plural(money.problems, 'report line')} that ${money.problems === 1 ? "doesn't" : "don't"} match the books` : null,
      quiet.length ? `a matched sale from ${list(quiet)}` : null,
      currencies.length ? `a matched ${listOr(currencies)} sale` : null,
    ].filter((gap): gap is string => Boolean(gap));

    // Switch-off: tested on all three channels, and nobody charged after.
    const tested = { website: 0, appStore: 0, googlePlay: 0 };
    for (const off of report.switchOffs) {
      for (const key of Object.keys(tested) as (keyof typeof tested)[]) tested[key] += off.renewalsDue[key] + off.chargedAfter[key];
    }
    const untested = (Object.keys(tested) as (keyof typeof tested)[]).filter((key) => !tested[key]).map((key) => ({ website: 'the website', appStore: 'the App Store', googlePlay: 'Google Play' })[key]);

    // Video: the 4G bar, plus starts from three states and from abroad, as the spec asks.
    const places = report.video.byPlace;
    const states = places.filter((place) => place.place !== 'Outside India' && place.starts >= 5);
    const fastStates = states.filter((place) => place.p90Ms !== null && place.p90Ms <= videoStart.targetMs);
    const abroad = places.find((place) => place.place === 'Outside India');
    const slower = states.filter((s) => !fastStates.includes(s)).map((s) => s.place);
    const videoGaps = [
      !videoStart.enough ? `${videoStart.minStarts - videoStart.starts} more starts on 4G (${videoStart.starts} of ${videoStart.minStarts})` : !videoStart.met ? `9 in 10 starts on 4G within 2 s; now up to ${(videoStart.p90Ms! / 1000).toFixed(1)} s` : null,
      fastStates.length < 3 ? `within 2 s in three states; ${fastStates.length ? `${list(fastStates.map((s) => s.place))} so far` : 'none yet'}${slower.length ? `, and ${list(slower)} slower` : ''}` : null,
      !abroad?.starts ? 'a start from outside India' : null,
    ].filter((gap): gap is string => Boolean(gap));
    const videoSlow = videoStart.enough && !videoStart.met;

    return [
      {
        key: 'bar_money',
        title: 'Two weeks of payments reconcile to the rupee',
        blocking: true,
        page: PAGES.reconciliation,
        ...(money.met
          ? { status: 'done' as const, detail: `${money.reconciled} of ${money.due} payments match the reports, on all three channels, in rupees and dollars.` }
          : !money.sales
            ? {
                status: 'waiting' as const,
                detail: 'No payments in the last 14 days. It needs sales on the website, Google Play and the App Store, in rupees and in dollars, each matched to its report.',
              }
            : {
                status: late || money.problems ? ('todo' as const) : ('waiting' as const),
                detail: `${money.due ? `${money.reconciled} of ${money.due} due so far match. ` : ''}Still to go: ${moneyGaps.join('; ')}.${money.waiting ? ` ${plural(money.waiting, 'sale')} ${money.waiting === 1 ? "isn't" : "aren't"} reported yet.` : ''}`,
              }),
      },
      {
        key: 'bar_switch_off',
        title: 'A switched-off subscription stops renewing everywhere',
        blocking: true,
        page: PAGES.beta,
        ...(switchOff.chargedAfter > 0
          ? { status: 'todo' as const, detail: `${plural(switchOff.chargedAfter, 'renewal was', 'renewals were')} charged after a teacher switched off. Beta health has which.` }
          : !switchOff.switchOffs
            ? {
                status: 'waiting' as const,
                detail: "No teacher has switched a subscription off yet. Subscribe to one from a test account on the website, the App Store and Google Play, switch the teacher off, and let each renewal fall due.",
              }
            : untested.length
            ? {
                status: 'waiting' as const,
                detail: `Nobody charged after ${plural(switchOff.switchOffs, 'switch-off')}, but no renewal has fallen due since on ${list(untested)}. Subscribe from a test account there before the next one.`,
              }
            : { status: 'done' as const, detail: `Renewals fell due after a switch-off on all three channels, ${switchOff.renewalsTested} in all, and nobody was charged.` }),
      },
      {
        key: 'bar_crash_free',
        title: 'Crash-free sessions above 99.5%',
        blocking: true,
        page: PAGES.beta,
        ...(!crashFree.enough
          ? { status: 'waiting' as const, detail: `${crashFree.sessions} sessions on iOS and Android so far; it calls it at ${crashFree.minSessions}.` }
          : crashFree.met
            ? { status: 'done' as const, detail: `${percent(crashFree.valueBps)} of ${crashFree.sessions} sessions, ${plural(crashFree.crashes, 'crash', 'crashes')}.` }
            : { status: 'todo' as const, detail: `${percent(crashFree.valueBps)} of ${crashFree.sessions} sessions: ${plural(crashFree.crashes, 'crash', 'crashes')}. Beta health groups them by problem.` }),
      },
      {
        key: 'bar_video',
        title: 'Video starts within 2 seconds on 4G, in three states and from abroad',
        blocking: true,
        page: PAGES.beta,
        ...(!videoGaps.length
          ? {
              status: 'done' as const,
              detail: `9 in 10 starts on 4G within ${(videoStart.p90Ms! / 1000).toFixed(1)} s, from ${videoStart.starts} starts; within 2 s in ${list(fastStates.map((s) => s.place))}; and tested from outside India.`,
            }
          : !videoStart.starts && !places.length
            ? {
                status: 'waiting' as const,
                detail: 'No chapters started on 4G yet. It needs 30 starts on 4G with 9 in 10 within 2 seconds, from at least three states, and some from outside India.',
              }
            : { status: videoSlow || (fastStates.length < states.length && states.length >= 3) ? ('todo' as const) : ('waiting' as const), detail: `Still to go: ${videoGaps.join('; ')}.` }),
      },
    ];
  }

  /* ------------------------------------------------------------ Sign-offs */

  private async signoffChecks(): Promise<Check[]> {
    const rows = await this.db
      .select({ key: launchSignoffs.key, at: launchSignoffs.signedAt, note: launchSignoffs.note, name: users.name, email: users.email })
      .from(launchSignoffs)
      .leftJoin(users, eq(users.id, launchSignoffs.signedBy));
    return SIGNOFFS.map((item) => {
      const row = rows.find((r) => r.key === item.key);
      return {
        key: item.key,
        title: item.title,
        detail: item.detail,
        blocking: true,
        status: row ? ('done' as const) : ('todo' as const),
        signoff: row ? { by: row.name ?? row.email ?? null, at: row.at.toISOString(), note: row.note } : null,
      };
    });
  }

  async signOff(actorId: string, key: string, note: string | null) {
    if (!SIGNOFFS.some((item) => item.key === key)) throw fail(404, 'not_found', 'There is no sign-off by that name.');
    const clean = note?.trim() ? note.trim().slice(0, 500) : null;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(launchSignoffs)
        .values({ key, signedBy: actorId, note: clean })
        .onConflictDoUpdate({ target: launchSignoffs.key, set: { signedBy: actorId, signedAt: new Date(), note: clean } });
      await audit(tx, { actorId, action: 'launch.signoff', entityType: 'launch', entityId: key, after: { note: clean } });
    });
    return { key, signed: true };
  }

  async withdraw(actorId: string, key: string) {
    const [row] = await this.db.delete(launchSignoffs).where(eq(launchSignoffs.key, key)).returning();
    if (!row) throw fail(404, 'not_found', "That one isn't signed off.");
    await audit(this.db, { actorId, action: 'launch.signoff_withdrawn', entityType: 'launch', entityId: key, before: { signedBy: row.signedBy, signedAt: row.signedAt, note: row.note } });
    return { key, signed: false };
  }

  /* ------------------------------------------------------------ Apple's test notification */

  /**
   * Asks Apple's production and sandbox servers each to send a TEST notification to the URLs set in App Store
   * Connect. The checklist then shows whether they arrived.
   */
  async askAppleForTest(actorId: string) {
    if (!this.apple.ready) throw fail(503, 'store_not_configured', 'App Store purchases are not switched on for this server yet.');
    const results = await Promise.all(
      (['Production', 'Sandbox'] as const).map(async (environment) => {
        try {
          await this.apple.requestTestNotification(environment);
          return { environment, asked: true as const };
        } catch (error) {
          return { environment, asked: false as const, problem: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    if (!results.some((r) => r.asked)) throw fail(502, 'app_store_error', results.map((r) => `${r.environment}: ${'problem' in r ? r.problem : ''}`).join(' '));
    const at = new Date().toISOString();
    await this.db
      .insert(settings)
      .values({ key: 'launch_apple_test', value: { at }, updatedBy: actorId })
      .onConflictDoUpdate({ target: settings.key, set: { value: { at }, updatedBy: actorId } });
    return { at, results };
  }

  /**
   * Reads every finished video without a downloadable copy from Bunny again: after MP4 fallback is switched on and
   * older videos re-encoded, or for videos that finished before this server started keeping track. One at a time,
   * so a big library doesn't trip Bunny's rate limit.
   */
  async lookForVideoDownloads(actorId: string) {
    if (!this.env.BUNNY_STREAM_LIBRARY_ID || !this.env.BUNNY_STREAM_API_KEY) throw fail(503, 'video_host_not_configured', "Bunny Stream isn't set up on this server.");
    const waiting = await this.db
      .select({ guid: mediaAssets.hostAssetId })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.provider, 'bunny_stream'), eq(mediaAssets.status, 'ready'), sql`cardinality(${mediaAssets.downloadHeights}) = 0`));
    let saveable = 0;
    const problems: string[] = [];
    for (const { guid } of waiting) {
      try {
        const updated = await this.media.syncFromBunny(guid);
        if (updated?.downloadHeights.length) saveable += 1;
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    await audit(this.db, { actorId, action: 'launch.video_downloads', entityType: 'launch', entityId: 'video_downloads', after: { looked: waiting.length, saveable } });
    return { looked: waiting.length, saveable, problem: problems[0] ?? null };
  }

  /* ------------------------------------------------------------ Plumbing */

  private async receipts() {
    const rows = await this.db.select().from(webhookReceipts);
    return Object.fromEntries(WEBHOOK_SOURCES.map((source) => [source, rows.find((row) => row.source === source) ?? null])) as Record<
      (typeof WEBHOOK_SOURCES)[number],
      (typeof webhookReceipts.$inferSelect) | null
    >;
  }

  /** One page or file on the web, remembered for a couple of minutes. Never throws: a failure is part of the answer. */
  private probe(url: string, follow = true): Promise<Probe> {
    return this.remember(`probe ${follow} ${url}`, async () => {
      try {
        const res = await fetch(url, { redirect: follow ? 'follow' : 'manual', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'Embodha launch checklist' } });
        const body = res.status < 400 ? (await res.text()).slice(0, 200_000) : '';
        return { status: res.status, type: res.headers.get('content-type') ?? '', body, location: res.headers.get('location'), error: null };
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
        return { status: null, type: '', body: '', location: null, error: timedOut ? "didn't answer within 6 seconds" : `couldn't be reached${cause ? ` (${cause})` : ''}` };
      }
    });
  }

  /** A domain's TXT records; an empty list when it has none, null when the lookup itself failed. */
  txt(name: string): Promise<string[] | null> {
    return this.remember(`txt ${name}`, async () => {
      try {
        return (await dns.resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch (error) {
        const code = (error as { code?: string }).code;
        return code === 'ENODATA' || code === 'ENOTFOUND' ? [] : null;
      }
    });
  }

  private remember<T>(key: string, work: () => Promise<T>): Promise<T> {
    const hit = this.outside.get(key);
    if (hit && Date.now() - hit.at < OUTSIDE_TTL_MS) return hit.value as Promise<T>;
    const value = work();
    this.outside.set(key, { at: Date.now(), value });
    return value;
  }
}
