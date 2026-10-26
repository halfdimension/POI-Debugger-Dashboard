export interface AuthUser {
  id: string;
  issuer: string;
  subject: string;
  display_name: string;
  email: string | null;
  username?: string;
  role?: 'user' | 'super_admin';
  auth_provider?: 'local' | 'oidc' | 'development';
}

export interface AuthSession {
  user: AuthUser;
  csrf_token: string;
  expires_at: number;
  auth_mode: 'local' | 'oidc' | 'local_oidc' | 'development';
}

export interface AuthConfig {
  mode: 'local' | 'oidc' | 'local_oidc' | 'development';
  local_login_available: boolean;
  oidc_login_available: boolean;
  development_login_available: boolean;
  csrf_token: string;
}

export interface RegistrationInput {
  full_name: string;
  username: string;
  email: string;
  password: string;
  confirm_password: string;
}

export class AuthApiError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
  }
}

let csrfToken = '';
let csrfStateVersion = 0;
let csrfInitialization: Promise<AuthConfig> | null = null;
let authRequestTail: Promise<void> = Promise.resolve();
let activeAuthRequest: Promise<void> | null = null;

export function setAuthSession(session: AuthSession | null): void {
  csrfStateVersion += 1;
  csrfToken = session?.csrf_token ?? '';
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(input, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('vpd:session-expired'));
  }
  return response;
}

async function requestAuthConfig(): Promise<AuthConfig> {
  if (csrfInitialization) return csrfInitialization;

  const versionAtStart = csrfStateVersion;
  const request = (async () => {
    const response = await fetch('/api/auth/config', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Authentication configuration failed: ${response.status}`);
    const config = await response.json() as AuthConfig;
    if (typeof config.csrf_token !== 'string' || !config.csrf_token) {
      throw new Error('Authentication configuration did not provide a CSRF token');
    }
    if (csrfStateVersion === versionAtStart) csrfToken = config.csrf_token;
    return config;
  })();
  csrfInitialization = request;
  try {
    return await request;
  } finally {
    if (csrfInitialization === request) csrfInitialization = null;
  }
}

export async function getAuthConfig(): Promise<AuthConfig> {
  if (activeAuthRequest) {
    await activeAuthRequest;
    return getAuthConfig();
  }
  return requestAuthConfig();
}

export async function getCurrentSession(): Promise<AuthSession | null> {
  const response = await fetch('/api/auth/current', { credentials: 'same-origin' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
  const session = await response.json() as AuthSession;
  setAuthSession(session);
  return session;
}

export async function developmentLogin(): Promise<AuthSession> {
  const response = await fetch('/api/auth/dev-login', { method: 'POST', credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : 'Development login failed');
  setAuthSession(body as AuthSession);
  return body as AuthSession;
}

async function ensureCsrfToken(): Promise<void> {
  if (csrfInitialization) await csrfInitialization;
  if (csrfToken) return;
  await requestAuthConfig();
  if (!csrfToken) {
    // A session transition superseded the configuration response. Initialize
    // once more against the current browser session rather than using it.
    await requestAuthConfig();
  }
  if (!csrfToken) throw new Error('Unable to initialize CSRF protection');
}

async function refreshCsrfToken(): Promise<void> {
  if (csrfInitialization) await csrfInitialization.catch(() => undefined);
  csrfStateVersion += 1;
  csrfToken = '';
  await ensureCsrfToken();
}

interface AuthJsonResponse {
  response: Response;
  body: any;
}

async function submitAuthJson(path: string, payload: object): Promise<AuthJsonResponse> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

function isInvalidCsrfResponse({ response, body }: AuthJsonResponse): boolean {
  return response.status === 403 && body?.detail === 'Invalid CSRF token';
}

function authResponseBody<T>({ response, body }: AuthJsonResponse): T {
  if (!response.ok) {
    const detail = body?.detail;
    if (detail && typeof detail === 'object') {
      throw new AuthApiError(detail.message ?? 'Authentication request failed', detail.field);
    }
    throw new AuthApiError(typeof detail === 'string' ? detail : 'Authentication request failed');
  }
  return body as T;
}

function withAuthRequestLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = async () => {
    let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; });
    activeAuthRequest = active;
    try {
      return await operation();
    } finally {
      if (activeAuthRequest === active) activeAuthRequest = null;
      finish();
    }
  };
  const request = authRequestTail.then(run, run);
  authRequestTail = request.then(() => undefined, () => undefined);
  return request;
}

async function authJson<T>(path: string, payload: object, onSuccess?: (body: T) => void): Promise<T> {
  return withAuthRequestLock(async () => {
    await ensureCsrfToken();
    let result = await submitAuthJson(path, payload);
    if (isInvalidCsrfResponse(result)) {
      await refreshCsrfToken();
      result = await submitAuthJson(path, payload);
    }
    const body = authResponseBody<T>(result);
    onSuccess?.(body);
    return body;
  });
}

export async function passwordLogin(identifier: string, password: string): Promise<AuthSession> {
  return authJson<AuthSession>('/api/auth/password-login', { identifier, password }, setAuthSession);
}

export async function registerAccount(input: RegistrationInput): Promise<void> {
  await authJson('/api/auth/register', input);
}

export async function logout(): Promise<void> {
  const response = await apiFetch('/api/auth/logout', { method: 'POST' });
  if (!response.ok) throw new Error(`Logout failed: ${response.status}`);
  setAuthSession(null);
}
