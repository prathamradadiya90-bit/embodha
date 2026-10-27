export type StaffRole = 'super_admin' | 'content' | 'finance' | 'support';
export type CourseStatus = 'draft' | 'in_review' | 'published' | 'archived';
export type MediaStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export interface Me {
  id: string;
  email: string;
  name: string | null;
  roles: { staff: StaffRole[]; instructor: { id: string; slug: string; status: string } | null };
}

export interface Review {
  submittedAt: string;
  decision: 'approved' | 'rejected' | null;
  comments: string | null;
}

/* Studio */

export interface StudioMe {
  instructor: { id: string; slug: string; displayName: string; bio: string | null; photoUrl: string | null };
  sharePercentBps: number | null;
  plan: { enabled: boolean; pricePointId: string | null };
  thisMonth: { month: string; minutes: number; members: number };
}

export interface PriceOption {
  id: string;
  code: string;
  inr: string;
  usd: string;
}

export interface StudioOptions {
  topics: { id: string; name: string; category: string }[];
  coursePrices: PriceOption[];
  planPrices: PriceOption[];
}

export interface StudioCourseRow {
  id: string;
  slug: string;
  title: string;
  status: CourseStatus;
  isFree: boolean;
  updatedAt: string;
}

export interface StudioChapter {
  id: string;
  title: string;
  type: 'video' | 'audio';
  isPreview: boolean;
  sort: number;
  durationS: number | null;
  media: { id: string; status: MediaStatus; error: string | null } | null;
  /** Added in changes to a live course; it joins the course when they're approved. */
  isNew?: boolean;
}

export interface StudioCourse {
  id: string;
  slug: string;
  title: string;
  topicId: string;
  description: string | null;
  level: 'beginner' | 'intermediate' | 'advanced' | 'all';
  language: string;
  equipment: string[];
  cautions: string | null;
  pricePointId: string | null;
  isFree: boolean;
  status: CourseStatus;
  chapters: StudioChapter[];
  review: Review | null;
  /** Live courses only: the copy being edited, if any, and admin's last word on changes. */
  changes: {
    state: 'editing' | 'in_review' | null;
    submittedAt: string | null;
    lastDecision: { decision: 'approved' | 'rejected'; comments: string | null; reviewedAt: string } | null;
  } | null;
}

export interface UploadTicket {
  mediaId: string;
  status: MediaStatus;
  tus: { endpoint: string; headers: Record<string, string | number>; expiresAt: string };
}

export interface MediaState {
  id: string;
  status: MediaStatus;
  durationS: number | null;
  error: string | null;
}

/* Admin */

export interface Overview {
  members: { total: number; last7Days: number };
  instructors: { approved: number; applied: number };
  courses: { published: number; inReview: number; draft: number };
  thisMonth: { month: string; minutes: number; members: number; breathingSessions: number };
  /** 'new': a course waiting to be published. 'changes': edits to a live course waiting for approval. */
  reviewQueue: { id: string; title: string; instructor: string; submittedAt: string | null; kind: 'new' | 'changes' }[];
}

export interface AdminCourse {
  id: string;
  slug: string;
  title: string;
  status: CourseStatus;
  isFree: boolean;
  instructor: { id: string; displayName: string };
  topic: string;
  price: string | null;
  chapters: number;
  readyChapters: number;
  updatedAt: string;
  review: Review | null;
  /** When the instructor sent changes to this live course, if they're waiting. */
  changesWaitingSince: string | null;
}

/** GET /v1/admin/courses/:id/changes: each change as it was and as it would be. */
export interface CourseChanges {
  course: { id: string; title: string; slug: string };
  submittedAt: string;
  items: { what: string; before?: string | null; after?: string | null }[];
}

export interface AdminInstructor {
  id: string;
  slug: string;
  displayName: string;
  email: string | null;
  status: 'applied' | 'approved' | 'rejected' | 'suspended';
  sharePercentBps: number | null;
  tdsRateBps: number;
  plan: { enabled: boolean; price: string | null };
  courses: { published: number; total: number };
  minutesThisMonth: number;
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  country: string | null;
  /** In India, "Karnataka (29)". */
  state: string | null;
  birthYear: number | null;
  gender: string | null;
  status: 'active' | 'suspended' | 'deleting' | 'erased';
  createdAt: string;
}

export interface MemberRow extends Member {
  staff: StaffRole[];
  instructor: boolean;
}

export interface MemberDetail {
  user: Member;
  courses: { courseId: string; title: string; slug: string; source: 'purchase' | 'grant'; since: string }[];
  minutesWatched: number;
  lastSignedIn: string | null;
}

export interface CatalogueCategory {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  topics: { id: string; slug: string; name: string; active: boolean; courses: number }[];
}

export interface AdminReview {
  id: string;
  rating: number;
  body: string | null;
  status: 'visible' | 'hidden' | 'reported';
  teamReply: string | null;
  createdAt: string;
  course: { id: string; slug: string; title: string };
  member: { id: string; email: string; name: string | null };
}

export interface Audience {
  genders?: string[];
  ageMin?: number;
  ageMax?: number;
  countries?: string[];
}

export interface Campaign {
  id: string;
  title: string;
  body: string;
  deepLink: string | null;
  audience: Audience | null;
  scheduledAt: string | null;
  sentAt: string | null;
  sentCount: number;
  /** Members whose push waited for their quiet hours to end. */
  heldCount: number;
  members: number;
  read: number;
}

export interface WatchReport {
  month: string;
  rows: { instructor: { id: string; displayName: string }; minutes: number; members: number; sharePercentBps: number | null }[];
  totals: { minutes: number; members: number };
}

/* Money */

export interface Money {
  currency: 'INR' | 'USD';
  amountMinor: number;
  display: string;
}

export interface AdminPayment {
  id: string;
  invoiceNo: string | null;
  /** Set once an invoiced sale is refunded. */
  creditNoteNo: string | null;
  /** "Karnataka (29)", "Outside India (96)", or null for store sales. */
  placeOfSupply: string | null;
  /** "CGST + SGST" or "IGST" when the GST was split. */
  tax: string | null;
  at: string | null;
  channel: 'razorpay' | 'apple' | 'google';
  member: string;
  kind: 'course' | 'subscription';
  course: string;
  instructor: string;
  gross: Money;
  currency: 'INR' | 'USD';
  netInrPaise: number;
  /** channel: the gateway gave it at the time; estimate: the usual rate; report: a settlement or store report gave it. */
  feeSource: 'channel' | 'estimate' | 'report';
  /** What the channel actually paid out for the sale, once reconciled. */
  settledInrPaise: number | null;
  reconciledAt: string | null;
  split: { percentBps: number; instructorPaise: number; embodhaPaise: number; state: 'pending' | 'payable' | 'paid' | 'reversed'; payableFrom: string | null } | null;
  status: 'captured' | 'refunded' | 'partially_refunded' | 'failed';
  /** An App Store sandbox or Play test purchase: unlocks, but no money moves. */
  test: boolean;
}

export type StoreProductStatus = 'pending' | 'in_review' | 'live' | 'failed' | 'off_sale';
export interface StoreLink {
  id: string;
  productId: string;
  status: StoreProductStatus;
  note: string | null;
  /** Made and kept up by the server; otherwise linked by hand. */
  auto: boolean;
  storeState: string | null;
  syncedAt: string | null;
}
interface StoreRow {
  price: { inr: string; usd: string } | null;
  suggestedId: string;
  apple: StoreLink | null;
  google: StoreLink | null;
}
export interface StoreProducts {
  commissionBps: number;
  automation: { apple: boolean; google: boolean };
  /** Courses and teachers the server is making products for right now. */
  working: string[];
  courses: (StoreRow & { id: string; title: string; slug: string; status: CourseStatus; instructor: string })[];
  plans: (StoreRow & { instructorId: string; displayName: string; slug: string; enabled: boolean })[];
}

export interface PayoutSummary {
  month: string;
  status: 'open' | 'closed' | 'paid';
  closedAt: string | null;
  lines: number;
  netPaise: number;
  paidLines: number;
}

export interface PayoutStatement {
  month: string;
  status: 'open' | 'closed' | 'paid';
  closedAt: string | null;
  lines: {
    id: string;
    instructor: { id: string; displayName: string; email: string | null; gstin: string | null };
    payablePaise: number;
    tdsPaise: number;
    netPaise: number;
    paidAt: string | null;
    bankReference: string | null;
  }[];
}

export interface Earnings {
  sharePercentBps: number;
  thisMonth: { sales: number; earnedPaise: number };
  unpaidPaise: number;
  sales: { at: string | null; course: string | null; price: Money; yourSharePaise: number; refunded: boolean }[];
  payouts: { month: string; netPaise: number; tdsPaise: number; paidAt: string | null; bankReference: string | null }[];
}

/** GET /v1/admin/analytics. Rates are basis points (3333 = 33.33%). Days are Indian days, oldest first. */
export interface AnalyticsReport {
  days: 7 | 30 | 90;
  active: { today: number; week: number; month: number; stickinessBps: number; daily: { day: string; members: number; guests: number }[] };
  activation: { signups: number; practised: number; rateBps: number; waiting: number };
  courses: { viewers: number; buyers: number; rateBps: number; top: { title: string; slug: string; viewers: number; buyers: number; rateBps: number }[] };
  lockedFunnel: { locked: number; started: number; done: number };
  weekOne: { week: string; final: boolean; signups: number; returned: number; rateBps: number }[];
  topCourses: { title: string; slug: string; minutes: number }[];
  topTeachers: { name: string; minutes: number; earnedPaise: number }[];
}

/** Paise: the value before tax, each tax, and the total. */
export interface GstAmounts {
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
}

export interface GstPlace {
  code: string;
  place: string;
  invoices: number;
  sales: GstAmounts;
  creditNotes: number;
  credited: GstAmounts;
  /** Sales less this month's credit notes: what GSTR-1 takes for sales to consumers. */
  net: GstAmounts;
}

export interface GstDocumentRange {
  from: string;
  to: string;
  count: number;
}

export interface GstRegisterRow {
  type: 'Invoice' | 'Credit note';
  number: string;
  /** YYYY-MM-DD, Indian time. */
  date: string;
  against: string | null;
  /** The state on the buyer's account at the sale, "Karnataka (29)"; null if they hadn't given one, or abroad. */
  buyerState: string | null;
  placeOfSupply: string | null;
  place: string | null;
  currency: 'INR' | 'USD';
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  inrPaise: number;
  refunded: boolean;
}

export interface GstReport {
  month: string;
  seller: { gstin: string | null; state: string | null; sac: string | null };
  india: { byPlace: GstPlace[]; totals: { invoices: number; sales: GstAmounts; creditNotes: number; credited: GstAmounts; net: GstAmounts } };
  exports: { invoices: number; sales: GstAmounts; salesInrPaise: number; creditNotes: number; credited: GstAmounts; creditedInrPaise: number };
  unsplit: { invoices: number; gstMinor: number; creditNotes: number; creditedGstMinor: number };
  /** Invoices in India taxed in the seller's state because the buyer had given none (renewals only). */
  stateMissing: number;
  documents: { invoices: GstDocumentRange | null; creditNotes: GstDocumentRange | null };
  register: GstRegisterRow[];
}

/* ---------------------------------------------------------------- Beta health and feedback */

/** Counted per channel: the website (Razorpay), the App Store and Google Play. */
export interface ByChannel {
  website: number;
  appStore: number;
  googlePlay: number;
}

export interface StartTimes {
  starts: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

/** GET /v1/admin/beta: the launch bars, and what's behind each. */
export interface BetaReport {
  days: number;
  bars: {
    crashFree: { valueBps: number | null; targetBps: number; minSessions: number; sessions: number; crashes: number; enough: boolean; met: boolean };
    videoStart: { p90Ms: number | null; targetMs: number; minStarts: number; starts: number; enough: boolean; met: boolean };
    switchOff: { switchOffs: number; renewalsTested: number; chargedAfter: number; enough: boolean; met: boolean };
    reconciliation: ReconBar;
  };
  crashes: {
    byPlatform: { platform: 'ios' | 'android'; sessions: number; crashes: number; crashFreeBps: number | null }[];
    byVersion: { platform: 'ios' | 'android'; version: string; sessions: number; crashes: number; crashFreeBps: number | null }[];
  };
  problems: {
    fingerprint: string;
    kind: 'crash' | 'error';
    reports: number;
    installs: number;
    firstSeen: string;
    lastSeen: string;
    platforms: ('ios' | 'android' | 'web')[];
    versions: string[];
    message: string;
    stack: string | null;
    screen: string | null;
  }[];
  video: {
    overall: StartTimes & { apiP50Ms: number | null };
    byConnection: (StartTimes & { connection: string })[];
    byPlace: (StartTimes & { place: string })[];
    abandoned: number;
    gaveUpSlow: number;
    errors: number;
    /** Chapters sent to a TV with Chromecast, and the times a TV couldn't play one. */
    casts: number;
    castErrors: number;
  };
  switchOffs: { instructor: string; offAt: string; onAgainAt: string | null; renewalsDue: ByChannel; chargedAfter: ByChannel; testCharges: number }[];
  feedbackOpen: number;
}

export interface FeedbackItem {
  id: string;
  message: string;
  member: { email: string; name: string | null };
  screen: string | null;
  platform: 'ios' | 'android' | 'web';
  appVersion: string | null;
  osVersion: string | null;
  device: string | null;
  at: string;
  handledAt: string | null;
}

export interface FeedbackList {
  open: number;
  items: FeedbackItem[];
}

/* ---------------------------------------------------------------- Reconciliation */

export type ReconChannel = 'razorpay' | 'google' | 'apple';
export type ReconStatus = 'matched' | 'corrected' | 'booked' | 'unbooked' | 'differs' | 'other' | 'needs_rate' | 'explained';

export interface ReconChannelSummary {
  channel: ReconChannel;
  sales: number;
  tests: number;
  reconciled: number;
  /** Sales whose fee or proceeds came from a settlement or report rather than the estimate. */
  corrected: number;
  /** Sales still on an estimated fee. */
  estimated: number;
  /** Past the point the channel should have reported them. */
  late: number;
  waiting: number;
  currencies: ('INR' | 'USD')[];
  grossInrPaise: number;
  netInrPaise: number;
  settledInrPaise: number;
  /** The last day a report covers, YYYY-MM-DD. */
  reportedTo: string | null;
}

export interface ReconImport {
  id: string;
  channel: ReconChannel;
  source: 'api' | 'file';
  label: string;
  fileName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rates: Record<string, string>;
  at: string;
  lines: number;
  open: number;
  corrected: number;
  needsRates: string[];
  inrPaise: number;
}

export interface ReconAttention {
  id: number;
  channel: ReconChannel;
  kind: 'sale' | 'refund' | 'other';
  ref: string;
  status: ReconStatus;
  note: string | null;
  quantity: number;
  amountInrPaise: number | null;
  settledAt: string | null;
  settlementRef: string | null;
  report: string;
  payment: { id: string; externalId: string; invoiceNo: string | null; gross: string; capturedAt: string | null } | null;
}

export interface ReconOverview {
  month: string;
  razorpayReady: boolean;
  lastNightly: string | null;
  channels: ReconChannelSummary[];
  imports: ReconImport[];
  attention: ReconAttention[];
  overdue: { id: string; channel: ReconChannel; externalId: string; invoiceNo: string | null; gross: string; capturedAt: string | null }[];
}

export interface ReconImportResult {
  id: string | null;
  label: string;
  channel: ReconChannel;
  counts: Partial<Record<ReconStatus, number>>;
  repeated: number;
  needsRates: string[];
}

export interface ReconLine {
  id: number;
  kind: 'sale' | 'refund' | 'other';
  ref: string;
  status: ReconStatus;
  quantity: number;
  currency: string | null;
  grossMinor: number | null;
  feeMinor: number | null;
  taxMinor: number | null;
  amountInrPaise: number | null;
  bookedInrPaise: number | null;
  settlementRef: string | null;
  note: string | null;
  explanation: string | null;
  payment: { invoiceNo: string | null; externalId: string } | null;
}

/** The reconciliation launch bar on Beta health. */
export interface ReconBar {
  ready: true;
  sales: number;
  due: number;
  reconciled: number;
  waiting: number;
  problems: number;
  channels: Record<ReconChannel, { sales: number; due: number; reconciled: number }>;
  currencies: string[];
  enough: boolean;
  met: boolean;
}

/* ------------------------------------------------------------------ Launch checklist */

export type LaunchStatus = 'done' | 'todo' | 'waiting';

export interface LaunchCheck {
  key: string;
  title: string;
  status: LaunchStatus;
  detail: string;
  blocking: boolean;
  page?: { to: string; label: string };
  env?: string[];
  action?: 'apple_test' | 'video_downloads';
  /** Only on the gates a person signs off: who did, or null while nobody has. */
  signoff?: { by: string | null; at: string; note: string | null } | null;
}

export interface LaunchSection {
  key: string;
  title: string;
  checks: LaunchCheck[];
}

export interface Launch {
  ready: boolean;
  /** Checks that hold launch up and aren't done. */
  left: number;
  counts: Record<LaunchStatus, number>;
  total: number;
  sections: LaunchSection[];
  checkedAt: string;
}

export interface AppleTestResult {
  at: string;
  results: { environment: 'Production' | 'Sandbox'; asked: boolean; problem?: string }[];
}
