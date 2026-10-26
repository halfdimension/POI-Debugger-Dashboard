import { useEffect, useState, type FormEvent } from 'react';
import { getAdminOverview, getAdminUsers, setAdminUserStatus, type AdminOverview, type AdminUserPage } from '../../adminApi';

const PAGE_SIZE = 25;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function AdminConsole() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [directory, setDirectory] = useState<AdminUserPage | null>(null);
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const [counts, users] = await Promise.all([
        getAdminOverview(),
        getAdminUsers(search, page, PAGE_SIZE),
      ]);
      setOverview(counts);
      setDirectory(users);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  useEffect(() => { void load(); }, [search, page]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(draftSearch.trim());
  }

  async function changeStatus(id: string, username: string, current: 'active' | 'disabled') {
    const next = current === 'active' ? 'disabled' : 'active';
    if (!window.confirm(`${next === 'disabled' ? 'Disable' : 'Enable'} ${username}?${next === 'disabled' ? ' Their existing session will stop working immediately.' : ''}`)) return;
    setBusyId(id);
    setError('');
    try {
      await setAdminUserStatus(id, next);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId('');
    }
  }

  const pages = Math.max(1, Math.ceil((directory?.total ?? 0) / PAGE_SIZE));
  return (
    <main className="admin-console">
      <div className="admin-console__heading">
        <div><p className="product-kicker">Platform administration</p><h2>Super Admin Console</h2></div>
        <button type="button" onClick={() => void load()}>Refresh</button>
      </div>
      {error && <div className="admin-error" role="alert">{error}</div>}
      <section className="admin-overview" aria-label="User overview">
        <article><span>Total accounts</span><strong>{overview?.total ?? '—'}</strong></article>
        <article><span>Active accounts</span><strong>{overview?.active ?? '—'}</strong></article>
        <article><span>Disabled accounts</span><strong>{overview?.disabled ?? '—'}</strong></article>
      </section>
      <section className="admin-directory">
        <div className="admin-directory__toolbar">
          <div><h3>User Directory</h3><span>{directory?.total ?? 0} matching accounts</span></div>
          <form onSubmit={submitSearch} role="search">
            <input aria-label="Search users" placeholder="Search username or email" value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} maxLength={254} />
            <button type="submit">Search</button>
          </form>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Username</th><th>Full name</th><th>Email</th><th>Status</th><th>Role</th><th>Registered</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {directory?.users.map((account) => (
                <tr key={account.id}>
                  <td><strong>{account.username}</strong><small>{account.auth_provider}</small></td>
                  <td>{account.full_name}</td><td>{account.email || '—'}</td>
                  <td><span className={`account-status account-status--${account.status}`}>{account.status}</span></td>
                  <td>{account.role === 'super_admin' ? 'Super Admin' : 'User'}</td>
                  <td>{formatDate(account.created_at)}</td>
                  <td>{account.role === 'user' && <button type="button" className={account.status === 'active' ? 'danger-action' : ''} disabled={busyId === account.id} onClick={() => void changeStatus(account.id, account.username, account.status)}>{busyId === account.id ? 'Saving…' : account.status === 'active' ? 'Disable' : 'Enable'}</button>}</td>
                </tr>
              ))}
              {directory?.users.length === 0 && <tr><td colSpan={7} className="admin-empty">No accounts found.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="admin-pagination"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {pages}</span><button type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div>
      </section>
    </main>
  );
}
