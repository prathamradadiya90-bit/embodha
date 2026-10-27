import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { Analytics } from './pages/admin/Analytics';
import { Beta } from './pages/admin/Beta';
import { AdminCourses } from './pages/admin/Courses';
import { Catalogue } from './pages/admin/Catalogue';
import { Daily } from './pages/admin/Daily';
import { Feedback } from './pages/admin/Feedback';
import { Instructors } from './pages/admin/Instructors';
import { Notifications } from './pages/admin/Notifications';
import { Overview } from './pages/admin/Overview';
import { MoneySettings } from './pages/admin/MoneySettings';
import { Payments } from './pages/admin/Payments';
import { Payouts } from './pages/admin/Payouts';
import { Gst } from './pages/admin/Gst';
import { Launch } from './pages/admin/Launch';
import { StoreProducts } from './pages/admin/StoreProducts';
import { Reconciliation } from './pages/admin/Reconciliation';
import { Reports } from './pages/admin/Reports';
import { Reviews } from './pages/admin/Reviews';
import { UserDetail } from './pages/admin/UserDetail';
import { Users } from './pages/admin/Users';
import { SignIn } from './pages/SignIn';
import { CourseEditor } from './pages/studio/CourseEditor';
import { StudioHome } from './pages/studio/StudioHome';
import { Button, Card, Loading } from './ui/kit';
import { Layout } from './ui/Layout';
import '@fontsource/anton/400.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/italiana/400.css';
import './styles.css';

/** Staff land on admin, instructors on their studio; anyone else is told what this site is for. */
function Home() {
  const { ready, me, isStaff, isInstructor, signOut } = useAuth();
  if (!ready) return <Loading />;
  if (isStaff) return <Navigate to="/admin" replace />;
  if (isInstructor) return <Navigate to="/studio" replace />;
  return (
    <Card title="Nothing to manage here yet">
      <p className="muted" style={{ marginBottom: 16 }}>
        {me?.email} isn't an instructor or staff account. If you teach on Embodha, ask the team to add this address as an instructor, then sign in again.
      </p>
      <Button variant="secondary" onClick={() => void signOut()}>
        Sign out
      </Button>
    </Card>
  );
}

/** Keeps each part of the site to the accounts it's for. Anyone else (say, after a different person signs in) goes home. */
function Gate({ need }: { need: 'staff' | 'instructor' }) {
  const { isStaff, isInstructor } = useAuth();
  return (need === 'staff' ? isStaff : isInstructor) ? <Outlet /> : <Navigate to="/" replace />;
}

const router = createBrowserRouter([
  { path: '/sign-in', element: <SignIn /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      {
        element: <Gate need="instructor" />,
        children: [
          { path: 'studio', element: <StudioHome /> },
          { path: 'studio/courses/:id', element: <CourseEditor /> },
        ],
      },
      {
        element: <Gate need="staff" />,
        children: [
          { path: 'admin', element: <Overview /> },
          { path: 'admin/analytics', element: <Analytics /> },
          { path: 'admin/beta', element: <Beta /> },
          { path: 'admin/launch', element: <Launch /> },
          { path: 'admin/feedback', element: <Feedback /> },
          { path: 'admin/courses', element: <AdminCourses /> },
          { path: 'admin/instructors', element: <Instructors /> },
          { path: 'admin/users', element: <Users /> },
          { path: 'admin/users/:id', element: <UserDetail /> },
          { path: 'admin/reviews', element: <Reviews /> },
          { path: 'admin/notifications', element: <Notifications /> },
          { path: 'admin/catalogue', element: <Catalogue /> },
          { path: 'admin/daily', element: <Daily /> },
          { path: 'admin/reports', element: <Reports /> },
          { path: 'admin/payments', element: <Payments /> },
          { path: 'admin/payouts', element: <Payouts /> },
          { path: 'admin/reconciliation', element: <Reconciliation /> },
          { path: 'admin/gst', element: <Gst /> },
          { path: 'admin/store-products', element: <StoreProducts /> },
          { path: 'admin/money-settings', element: <MoneySettings /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
