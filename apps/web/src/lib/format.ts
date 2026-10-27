export const percent = (bps: number | null | undefined) => (bps === null || bps === undefined ? '—' : `${(bps / 100).toLocaleString('en-IN')}%`);

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const count = (n: number) => n.toLocaleString('en-IN');

export const monthName = (month: string) =>
  new Date(`${month}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

export const megabytes = (bytes: number) => `${(bytes / 1_048_576).toLocaleString('en-IN', { maximumFractionDigits: 0 })} MB`;

export const duration = (seconds: number | null) => {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
};

/** A spreadsheet-safe CSV: quotes everything, and stops cells being read as formulas. */
export function toCsv(rows: (string | number | null)[][]) {
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value);
    return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

/** 4938200 → "₹49,382". Paise only show when there are some. */
export const rupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(paise / 100);
