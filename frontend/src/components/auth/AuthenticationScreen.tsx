import { useState, type FormEvent } from 'react';
import {
  AuthApiError,
  passwordLogin,
  registerAccount,
  type AuthConfig,
  type AuthSession,
} from '../../auth';

interface AuthenticationScreenProps {
  config: AuthConfig | null;
  initialError: string;
  sessionExpired: boolean;
  onAuthenticated: (session: AuthSession) => void;
  onDevelopmentLogin: () => Promise<void>;
}

interface PasswordInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}

function LoginBrand() {
  return (
    <div className="login-brand" aria-label="MapmyIndia Engineering">
      <span className="login-brand__mark" aria-hidden="true"><i /></span>
      <span><strong>MapmyIndia</strong><small>Engineering</small></span>
    </div>
  );
}

function PasswordInput({ id, label, value, onChange, autoComplete }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="auth-field" htmlFor={id}>
      <span>{label}</span>
      <span className="password-input">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          maxLength={4096}
          required
        />
        <button type="button" onClick={() => setVisible((current) => !current)} aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}>
          {visible ? 'Hide' : 'Show'}
        </button>
      </span>
    </label>
  );
}

export function AuthenticationScreen({
  config,
  initialError,
  sessionExpired,
  onAuthenticated,
  onDevelopmentLogin,
}: AuthenticationScreenProps) {
  const [view, setView] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [signup, setSignup] = useState({ full_name: '', username: '', email: '', password: '', confirm_password: '' });

  const switchView = (next: 'sign-in' | 'sign-up') => {
    setView(next);
    setError('');
    setNotice('');
  };

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onAuthenticated(await passwordLogin(identifier, loginPassword));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (signup.password !== signup.confirm_password) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await registerAccount(signup);
      setIdentifier(signup.username);
      setLoginPassword('');
      setSignup({ full_name: '', username: '', email: '', password: '', confirm_password: '' });
      setView('sign-in');
      setNotice('Account created. Sign in with your username or email.');
    } catch (caught) {
      setError(caught instanceof AuthApiError ? caught.message : caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <section className={`login-card ${view === 'sign-up' ? 'login-card--signup' : ''}`} aria-labelledby="login-heading">
        <LoginBrand />
        <div className="login-card__intro">
          <p className="product-kicker">Internal engineering platform</p>
          <h1 id="login-heading">{view === 'sign-in' ? 'Sign in' : 'Create account'}</h1>
          <p className="login-subtitle">POI &amp; Routing Testing Workspace</p>
        </div>

        {sessionExpired && view === 'sign-in' && <div className="session-expired-message" role="alert">Your session expired. Sign in again to continue.</div>}
        {notice && <div className="auth-success" role="status">{notice}</div>}
        {error && <div className="auth-error" role="alert">{error}</div>}

        {view === 'sign-in' ? (
          <>
            {config?.local_login_available && (
              <form className="auth-form" onSubmit={(event) => void submitLogin(event)}>
                <label className="auth-field" htmlFor="login-identifier">
                  <span>Username or Email</span>
                  <input id="login-identifier" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" maxLength={254} required autoFocus />
                </label>
                <PasswordInput id="login-password" label="Password" value={loginPassword} onChange={setLoginPassword} autoComplete="current-password" />
                <button className="login-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</button>
                <button className="auth-link-button" type="button" onClick={() => switchView('sign-up')}>Create Account</button>
              </form>
            )}
            {config?.oidc_login_available && (
              <div className={config.local_login_available ? 'auth-alternative' : ''}>
                {config.local_login_available && <span>or</span>}
                <a className="login-button login-button--secondary" href="/api/auth/login?next=%2F">Sign in with company SSO <span aria-hidden="true">→</span></a>
              </div>
            )}
            {config?.development_login_available && (
              <div className="development-auth">
                <div className="development-auth-warning"><strong>Development only</strong><span>Loopback development authentication is enabled.</span></div>
                <button className="login-button login-button--development" type="button" disabled={busy} onClick={() => void onDevelopmentLogin()}>Continue as Local Developer</button>
              </div>
            )}
          </>
        ) : (
          <form className="auth-form" onSubmit={(event) => void submitRegistration(event)}>
            <label className="auth-field" htmlFor="signup-name"><span>Full Name</span><input id="signup-name" value={signup.full_name} onChange={(event) => setSignup({ ...signup, full_name: event.target.value })} autoComplete="name" minLength={2} maxLength={100} required autoFocus /></label>
            <label className="auth-field" htmlFor="signup-username"><span>Username</span><input id="signup-username" value={signup.username} onChange={(event) => setSignup({ ...signup, username: event.target.value })} autoComplete="username" pattern="[A-Za-z][A-Za-z0-9._-]{2,31}" title="3–32 characters; start with a letter and use letters, numbers, dots, underscores, or hyphens" required /></label>
            <label className="auth-field" htmlFor="signup-email"><span>Email</span><input id="signup-email" type="email" value={signup.email} onChange={(event) => setSignup({ ...signup, email: event.target.value })} autoComplete="email" maxLength={254} required /></label>
            <PasswordInput id="signup-password" label="Password" value={signup.password} onChange={(password) => setSignup({ ...signup, password })} autoComplete="new-password" />
            <PasswordInput id="signup-confirm-password" label="Confirm Password" value={signup.confirm_password} onChange={(confirmPassword) => setSignup({ ...signup, confirm_password: confirmPassword })} autoComplete="new-password" />
            <p className="password-guidance">Choose any nonempty password (up to 4096 characters).</p>
            <button className="login-button" type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create Account'}</button>
            <button className="auth-link-button" type="button" onClick={() => switchView('sign-in')}>Already have an account? Sign In</button>
          </form>
        )}
        <p className="login-security-note">Secure authentication · Protected company session</p>
      </section>
    </main>
  );
}
