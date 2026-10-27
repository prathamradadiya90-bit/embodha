import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { errorText } from '../lib/api';
import type { CourseStatus } from '../lib/types';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';

export function Button({ variant = 'primary', busy, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button type="button" {...props} className={`btn btn-${variant} ${props.className ?? ''}`} disabled={props.disabled || busy} aria-busy={busy}>
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function PageHeader({ title, lead, actions }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {lead ? <p className="lead">{lead}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}

type Tone = 'neutral' | 'amber' | 'green' | 'red' | 'maroon';
export const Badge = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => <span className={`badge badge-${tone}`}>{children}</span>;

const courseStatus: Record<CourseStatus, [string, Tone]> = {
  draft: ['Draft', 'neutral'],
  in_review: ['In review', 'amber'],
  published: ['Live', 'green'],
  archived: ['Archived', 'neutral'],
};
export const CourseStatusBadge = ({ status }: { status: CourseStatus }) => <Badge tone={courseStatus[status][1]}>{courseStatus[status][0]}</Badge>;

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span>{label}</span>
    </label>
  );
}

export const ErrorNote = ({ error }: { error: unknown }) => (error ? <p className="error-note" role="alert">{errorText(error)}</p> : null);

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export const Loading = () => <p className="loading">Loading…</p>;
