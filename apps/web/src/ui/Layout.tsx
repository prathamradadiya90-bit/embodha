import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import type { StaffRole } from '../lib/types';
import { Button, Loading } from './kit';

const adminLinks: { to: string; label: string; roles: StaffRole[] }[] = [
  { to: '/admin', label: 'Overview', roles: [] },
  { to: '/admin/analytics', label: 'Analytics', roles: ['finance', 'content'] },
  { to: '/admin/beta', label: 'Beta health', roles: [] },
  { to: '/admin/launch', label: 'Launch checklist', roles: [] },
  { to: '/admin/courses', label: 'Courses', roles: ['content', 'support'] },
  { to: '/admin/instructors', label: 'Instructors', roles: ['content', 'finance'] },
  { to: '/admin/users', label: 'Members', roles: ['support'] },
  { to: '/admin/reviews', label: 'Reviews', roles: ['support', 'content'] },
  { to: '/admin/feedback', label: 'Feedback', roles: ['support', 'content'] },
  { to: '/admin/notifications', label: 'Notifications', roles: ['content'] },
  { to: '/admin/catalogue', label: 'Catalogue', roles: ['content'] },
  { to: '/admin/daily', label: 'Today screen', roles: ['content'] },
  { to: '/admin/reports', label: 'Reports', roles: ['finance', 'content'] },
  { to: '/admin/payments', label: 'Payments', roles: ['finance', 'support'] },
  { to: '/admin/store-products', label: 'Store products', roles: ['content', 'finance'] },
  { to: '/admin/payouts', label: 'Payouts', roles: ['finance'] },
  { to: '/admin/reconciliation', label: 'Reconciliation', roles: ['finance'] },
  { to: '/admin/gst', label: 'GST', roles: ['finance'] },
  { to: '/admin/money-settings', label: 'Money settings', roles: ['finance'] },
];

/** Everything behind sign-in: the sidebar shows the studio to instructors and the parts of admin each role can use. */
export function Layout() {
  const { ready, me, isStaff, isInstructor, can, signOut } = useAuth();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!me) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;

  const link = (to: string, label: string) => (
    <NavLink key={to} to={to} end={to === '/admin' || to === '/studio'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
      {label}
    </NavLink>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="Embodha">
          <span className="star" aria-hidden />
          <span>embodha</span>
        </NavLink>
        {isInstructor ? (
          <nav className="nav-group" aria-label="Studio">
            <span className="nav-title">Studio</span>
            {link('/studio', 'My courses')}
          </nav>
        ) : null}
        {isStaff ? (
          <nav className="nav-group" aria-label="Admin">
            <span className="nav-title">Admin</span>
            {adminLinks.filter((item) => !item.roles.length || can(...item.roles)).map((item) => link(item.to, item.label))}
          </nav>
        ) : null}
        <div className="sidebar-foot">
          <span>{me.email}</span>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
