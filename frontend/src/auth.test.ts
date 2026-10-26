import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthConfig,
  logout,
  passwordLogin,
  registerAccount,
  setAuthSession,
  type AuthSession,
} from './auth';

const config = (csrfToken: string) => ({
  mode: 'local',
  local_login_available: true,
  oidc_login_available: false,
  development_login_available: false,
  csrf_token: csrfToken,
});

const session = (csrfToken: string): AuthSession => ({
  user: { id: '1', issuer: 'local', subject: '1', display_name: 'Test User', email: null },
  csrf_token: csrfToken,
  expires_at: 4_000_000_000,
  auth_mode: 'local',
});

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const registration = {
  full_name: 'Test User',
  username: 'test.user',
  email: 'test@example.com',
  password: 'password',
  confirm_password: 'password',
};

function csrfHeader(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit).headers).get('X-CSRF-Token');
}

describe('authentication CSRF lifecycle', () => {
  beforeEach(() => {
    setAuthSession(null);
    vi.restoreAllMocks();
  });

  it('logs in with the CSRF token initialized from authentication config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, config('anonymous-token')))
      .mockResolvedValueOnce(jsonResponse(200, session('authenticated-token')));

    await getAuthConfig();
    await expect(passwordLogin('test.user', 'password')).resolves.toEqual(session('authenticated-token'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(csrfHeader(fetchMock.mock.calls[1])).toBe('anonymous-token');
  });

  it('initializes a fresh anonymous token when logging in immediately after logout', async () => {
    setAuthSession(session('authenticated-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, config('post-logout-token')))
      .mockResolvedValueOnce(jsonResponse(200, session('next-session-token')));

    await logout();
    await passwordLogin('test.user', 'password');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(csrfHeader(fetchMock.mock.calls[0])).toBe('authenticated-token');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/config');
    expect(csrfHeader(fetchMock.mock.calls[2])).toBe('post-logout-token');
  });

  it('never submits a login request when the CSRF token is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, config('initialized-token')))
      .mockResolvedValueOnce(jsonResponse(200, session('authenticated-token')));

    await passwordLogin('test.user', 'password');

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/auth/config', '/api/auth/password-login']);
    expect(csrfHeader(fetchMock.mock.calls[1])).toBe('initialized-token');
  });

  it('refreshes a stale CSRF token and retries login once', async () => {
    setAuthSession(session('stale-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(403, { detail: 'Invalid CSRF token' }))
      .mockResolvedValueOnce(jsonResponse(200, config('refreshed-token')))
      .mockResolvedValueOnce(jsonResponse(200, session('authenticated-token')));

    await passwordLogin('test.user', 'password');

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/auth/password-login', '/api/auth/config', '/api/auth/password-login',
    ]);
    expect(csrfHeader(fetchMock.mock.calls[0])).toBe('stale-token');
    expect(csrfHeader(fetchMock.mock.calls[2])).toBe('refreshed-token');
  });

  it('initializes a fresh anonymous token for registration after logout', async () => {
    setAuthSession(session('authenticated-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, config('registration-token')))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true, username: registration.username }));

    await logout();
    await registerAccount(registration);

    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/config');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/auth/register');
    expect(csrfHeader(fetchMock.mock.calls[2])).toBe('registration-token');
  });

  it('does not retry an incorrect password', async () => {
    setAuthSession(session('valid-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, { detail: 'Invalid username/email or password' }),
    );

    await expect(passwordLogin('test.user', 'wrong')).rejects.toThrow('Invalid username/email or password');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an explicit CSRF rejection at most once', async () => {
    setAuthSession(session('stale-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(403, { detail: 'Invalid CSRF token' }))
      .mockResolvedValueOnce(jsonResponse(200, config('refreshed-token')))
      .mockResolvedValueOnce(jsonResponse(403, { detail: 'Invalid CSRF token' }));

    await expect(passwordLogin('test.user', 'password')).rejects.toThrow('Invalid CSRF token');
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/auth/password-login')).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/auth/config')).toHaveLength(1);
  });

  it('does not retry other HTTP errors', async () => {
    setAuthSession(session('valid-token'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(503, { detail: 'Authentication service is temporarily unavailable' }),
    );

    await expect(registerAccount(registration)).rejects.toThrow('Authentication service is temporarily unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares concurrent CSRF initialization before authentication requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, config('shared-token')))
      .mockResolvedValueOnce(jsonResponse(200, session('authenticated-token')))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true, username: registration.username }));

    await Promise.all([
      passwordLogin('test.user', 'password'),
      registerAccount(registration),
    ]);

    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/auth/config')).toHaveLength(1);
    expect(csrfHeader(fetchMock.mock.calls[1])).toBe('shared-token');
    expect(csrfHeader(fetchMock.mock.calls[2])).toBe('authenticated-token');
  });

  it('does not let an older config response overwrite a newly established session token', async () => {
    let resolveConfig!: (response: Response) => void;
    const pendingConfig = new Promise<Response>((resolve) => { resolveConfig = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(pendingConfig)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const configRequest = getAuthConfig();
    setAuthSession(session('new-session-token'));
    resolveConfig(jsonResponse(200, config('older-anonymous-token')));
    await configRequest;
    await logout();

    expect(csrfHeader(fetchMock.mock.calls[1])).toBe('new-session-token');
  });

  it('does not start a config request while authentication is in flight', async () => {
    setAuthSession(session('valid-token'));
    let resolveLogin!: (response: Response) => void;
    const pendingLogin = new Promise<Response>((resolve) => { resolveLogin = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(pendingLogin)
      .mockResolvedValueOnce(jsonResponse(200, config('authenticated-token')));

    const loginRequest = passwordLogin('test.user', 'password');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const configRequest = getAuthConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveLogin(jsonResponse(200, session('authenticated-token')));
    await loginRequest;
    await configRequest;

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/auth/password-login', '/api/auth/config',
    ]);
  });
});
