/**
 * Embodha's look: flat pastel grounds, bright tiles drawn with an ink outline, and three typefaces that play off
 * each other. Italiana (thin, high-contrast capitals) carries headlines, Anton (heavy, condensed) makes a few words
 * land, and DM Sans is for everything people read. No shadows, no gradients.
 * The breathing screen keeps its own quiet night palette.
 */
export const fonts = {
  display: 'Italiana_400Regular',
  heavy: 'Anton_400Regular',
  body: 'DMSans_400Regular',
  medium: 'DMSans_500Medium',
  bold: 'DMSans_700Bold',
};

export const colors = {
  paper: '#FFF7EC',
  surface: '#FFFFFF',
  ink: '#141414',
  inkSoft: '#5B5650',
  /** Outlines are ink, never grey. */
  line: '#141414',
  hairline: 'rgba(20, 20, 20, 0.16)',
  accent: '#141414',
  /** The older name for the accent. The brand maroon now lives only in the logo. */
  maroon: '#141414',
  brand: '#900201',
  maroonSoft: '#E6DFF7',

  // Grounds: each tab has its own.
  peach: '#FCE3BC',
  lilac: '#E6DFF7',
  mint: '#D4F3E3',
  sky: '#D7EDF6',
  butter: '#FBF0C6',

  // Tiles.
  green: '#2BE5A0',
  cyan: '#18D9D9',
  yellow: '#F7DE36',
  orange: '#FFA43C',
  violet: '#B9A6F2',
  pink: '#F6A6CB',
  sand: '#DCC9B1',
  coral: '#FF7D5C',

  // The breathing screen.
  night: '#1C2430',
  nightLine: '#344157',
  moon: '#EADBC6',
  mist: '#AEB8C6',
  sage: '#2F6B4F',
};

export type Ground = 'paper' | 'peach' | 'lilac' | 'mint' | 'sky' | 'butter' | 'surface';

/** Bright tiles, picked by name or slug so each course and topic keeps its colour. */
export const tiles = [colors.green, colors.cyan, colors.yellow, colors.orange, colors.violet, colors.pink, colors.sand, colors.coral];
export const covers = tiles;

export const space = (n: number) => n * 4;
export const radius = { sm: 12, md: 20, lg: 28, pill: 999 };
export const outline = 1.5;
/** Headlines. Older screens call it serif. */
export const serif = fonts.display;
