/** Shapes of the API responses the app reads. Kept by hand for now; generate from the OpenAPI file once it settles. */

export interface Price {
  currency: 'INR' | 'USD';
  amountMinor: number;
  display: string;
}

export interface InstructorSummary {
  id: string;
  slug: string;
  displayName: string;
  photoUrl: string | null;
}

export interface CourseCard {
  id: string;
  slug: string;
  title: string;
  coverUrl: string | null;
  level: string;
  instructor: InstructorSummary;
  isFree: boolean;
  price: Price | null;
  unlocked: boolean;
  chapterCount: number;
  totalDurationS: number;
  rating: { average: number | null; count: number };
}

export interface Category {
  slug: string;
  name: string;
  icon: string | null;
  topics: { slug: string; name: string; coverUrl: string | null; courseCount: number }[];
}

export interface ContinueItem {
  positionS: number;
  chapter: { id: string; title: string; type: 'video' | 'audio'; durationS: number | null };
  course: { slug: string; title: string; coverUrl: string | null };
}

export interface Home {
  breathing: { id: string; slug: string; name: string } | null;
  daily: { type: string; text: string | null; author: string | null } | null;
  /** The photo of the day, with its size so the screen can make room for it before it loads. */
  dailyImage: { url: string; caption: string | null; credit: string | null; width: number | null; height: number | null } | null;
  /** The short video of the day, free to everyone. */
  dailyClip: { url: string; thumbnailUrl: string | null; durationS: number | null; caption: string | null } | null;
  continueWatching: ContinueItem[];
  freeCourse: CourseCard | null;
  newCourses: CourseCard[];
  categories: Category[];
}

export interface Topic {
  slug: string;
  name: string;
  coverUrl: string | null;
  category: { slug: string; name: string };
  courses: CourseCard[];
}

export type AccessVia = 'free' | 'subscription' | 'purchase' | 'grant' | 'instructor';

export interface ChapterRow {
  id: string;
  title: string;
  type: 'video' | 'audio';
  durationS: number | null;
  isPreview: boolean;
  playable: boolean;
  ready: boolean;
  progress: { positionS: number; completed: boolean } | null;
  /** Roughly how big it is to save to the phone, in each quality; null when there's no file to save yet. */
  downloadBytes: { standard: number; high: number } | null;
}

export interface CourseDetail {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  level: string;
  language: string;
  equipment: string[];
  cautions: string | null;
  coverUrl: string | null;
  topic: { slug: string; name: string };
  category: { slug: string; name: string };
  instructor: InstructorSummary;
  isFree: boolean;
  price: Price | null;
  access: { unlocked: boolean; via: AccessVia | null };
  instructorSubscription: { price: Price | null } | null;
  rating: { average: number | null; count: number };
  totalDurationS: number;
  chapters: ChapterRow[];
}

export interface Playback {
  chapterId: string;
  type: 'video' | 'audio';
  title: string;
  course: { slug: string; title: string };
  /** The chapter after this one, locked or not. */
  next: { id: string; title: string } | null;
  url: string;
  expiresAt: string | null;
  durationS: number | null;
  resumePositionS: number;
  thumbnailUrl: string | null;
  /**
   * The link a TV streams from when the chapter is cast. The same as url, except for a saved copy, which the phone
   * plays from its file while the TV still streams; null offline.
   */
  streamUrl?: string | null;
  /** Playing the copy saved on the phone rather than streaming. */
  saved?: boolean;
  /** And without a connection: the details come from the download, not the server. */
  offline?: boolean;
}

export interface SearchResult {
  query: string;
  courses: CourseCard[];
  topics: { slug: string; name: string; category: string }[];
}

export interface ReviewsPage {
  average: number | null;
  count: number;
  canReview: boolean;
  mine: { rating: number; body: string | null; hidden: boolean } | null;
  items: { id: string; rating: number; body: string | null; author: string; createdAt: string; teamReply: string | null }[];
}

export interface Note {
  id: string;
  chapterId: string;
  timestampS: number | null;
  body: string;
  createdAt: string;
}

export interface Bell {
  unread: number;
  items: { id: string; title: string; body: string; deepLink: string | null; createdAt: string; readAt: string | null }[];
}

/** The body of a 402 from the playback endpoint. */
export interface Locked {
  code: 'locked';
  message: string;
  requiresAccount: boolean;
  instructor: { id: string };
  course: { id: string; slug: string; title: string };
  price: Price | null;
  instructorSubscription: { price: Price | null } | null;
}

export interface Me {
  id: string;
  email: string;
  name: string | null;
  country: string | null;
  /** In India, the state's GST code ('29' is Karnataka). */
  state: string | null;
  birthYear: number | null;
  gender: string | null;
  timezone: string | null;
  profileComplete: boolean;
  preferences: { goals: string[]; reminderTime: string | null; breathOnLaunch: boolean; language: string };
  roles: { staff: string[]; instructor: { id: string; slug: string; status: string } | null };
}

export interface Stats {
  streakDays: number;
  practicedToday: boolean;
  totalMinutes: number;
  breathingSessions: number;
}

export interface Library {
  courses: CourseCard[];
  subscriptions: { id: string; channel: 'razorpay' | 'apple' | 'google'; instructor: { slug: string; displayName: string }; status: string; renews: boolean; accessUntil: string }[];
}

export interface BreathingPattern {
  id?: string;
  slug: string;
  name: string;
  description: string | null;
  inhaleS: number;
  holdInS: number;
  exhaleS: number;
  holdOutS: number;
  rounds: number;
}
