import { apiFetch } from './auth';

export type AdminAccount = {
  id: string;
  full_name: string;
  username: string;
  email: string;
  status: 'active' | 'disabled';
  role: 'user' | 'super_admin';
  auth_provider: 'local' | 'oidc';
  created_at: string;
  last_login_at: string | null;
};

export type AdminOverview = { total: number; active: number; disabled: number };
export type AdminUserPage = { users: AdminAccount[]; total: number; page: number; page_size: number };

async function adminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `Admin request failed: ${response.status}`);
  return body as T;
}

export function getAdminOverview(): Promise<AdminOverview> {
  return adminJson('/api/admin/overview');
}

export function getAdminUsers(search: string, page: number, pageSize = 25): Promise<AdminUserPage> {
  const params = new URLSearchParams({ search, page: String(page), page_size: String(pageSize) });
  return adminJson(`/api/admin/users?${params}`);
}

export function setAdminUserStatus(id: string, status: 'active' | 'disabled'): Promise<AdminAccount> {
  return adminJson(`/api/admin/users/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}
