import { useState } from 'react';
import type { Auth } from '../types';

export function SignIn({ auth, onSignedIn }: { auth: Auth; onSignedIn: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form
        className="glass card signin"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (step === 'email') {
              await auth.requestCode(email);
              setStep('code');
            } else {
              await auth.confirmCode(code);
              onSignedIn(email);
            }
          });
        }}
      >
        <h1>Neverdue</h1>
        <p className="muted">Never pay a late fee again.</p>
        {step === 'email' ? (
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        ) : (
          <label>
            Code from your email
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Please wait…' : step === 'email' ? 'Email me a code' : 'Sign in'}
        </button>
        {step === 'code' && (
          <button type="button" className="btn ghost" onClick={() => setStep('email')}>
            Use a different email
          </button>
        )}
      </form>
    </div>
  );
}
