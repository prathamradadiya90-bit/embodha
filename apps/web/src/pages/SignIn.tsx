import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Field } from '../ui/kit';

export function SignIn() {
  const { ready, me, startSignIn, verify } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (ready && me) return <Navigate to={from} replace />;

  const run = async (event: FormEvent, action: () => Promise<void>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <section className="card">
        <img src="/logo.jpg" alt="Embodha" />
        {step === 'email' ? (
          <form
            className="stack"
            onSubmit={(e) =>
              void run(e, async () => {
                await startSignIn(email.trim());
                setStep('code');
              })
            }
          >
            <div>
              <h1>Studio and admin</h1>
              <p className="lead">For Embodha instructors and staff. We'll email you a six-digit code.</p>
            </div>
            <Field label="Email">
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <ErrorNote error={error} />
            <Button type="submit" busy={busy}>
              Email me a code
            </Button>
          </form>
        ) : (
          <form
            className="stack"
            onSubmit={(e) =>
              void run(e, async () => {
                await verify(email.trim(), code);
                navigate(from, { replace: true });
              })
            }
          >
            <div>
              <h1>Check your email</h1>
              <p className="lead">The code we sent to {email.trim()} works for 10 minutes.</p>
            </div>
            <Field label="Six-digit code">
              <input
                className="code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoFocus
              />
            </Field>
            <ErrorNote error={error} />
            <Button type="submit" busy={busy} disabled={code.length !== 6}>
              Sign in
            </Button>
            <Button variant="quiet" onClick={() => setStep('email')}>
              Use a different email
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
