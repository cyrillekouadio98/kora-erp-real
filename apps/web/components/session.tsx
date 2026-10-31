'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { SUB_STATUS } from '@/lib/format';
import { activeHref, AppIcon, currentApp } from './apps';
import { Pill } from './ui';

export interface Me {
  user: { id: string; email: string; fullName: string; mfaEnabled: boolean };
  platformRoles: string[]; activeCompanyId: string | null;
  companies: { companyId: string; name: string; status: string; isOwner: boolean }[];
}
export interface CompanyContext {
  company: { id: string; name: string; currency: string; status: string };
  isOwner: boolean; permissions: string[]; readOnly: boolean; subscriptionStatus: string | null;
  entitlements: { modules: string[]; quotas: Record<string, number | null> };
}

const Ctx = createContext<{ me: Me; ctx: CompanyContext | null; can: (p: string) => boolean; refresh: () => Promise<void> } | null>(null);
export const useSession = () => useContext(Ctx)!;


export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [ctx, setCtx] = useState<CompanyContext | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/auth/me');
      // Utilisateur et droits de l'entreprise sont posés ensemble : une page ne s'affiche jamais sans ses droits.
      const c = m.activeCompanyId ? await api<CompanyContext>('/company/context').catch(() => null) : null;
      setCtx(c);
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/connexion');
    }
  }, [router]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!me) return <main className="auth"><p className="muted">Chargement…</p></main>;
  const can = (p: string) => !!ctx?.permissions.includes(p);
  const switchTo = async (companyId: string) => { await api('/auth/switch-company', { body: { companyId } }); await refresh(); router.push('/app'); };
  const logout = async () => { await api('/auth/logout', { method: 'POST', body: {} }); router.replace('/connexion'); };
  const status = ctx?.subscriptionStatus ? SUB_STATUS[ctx.subscriptionStatus] : null;
  const home = path === '/app';
  const app = currentApp(path);
  const allowed = (x: { perm?: string; module?: string }) => (!x.perm || can(x.perm)) && (!x.module || !!ctx?.entitlements.modules.includes(x.module));
  const pages = app?.pages?.filter(allowed) ?? [];
  const activePage = activeHref(path, pages.map((p) => p.href));
  const companySelect = me.companies.length > 0 && (
    <select className="input" value={me.activeCompanyId ?? ''} onChange={(e) => switchTo(e.target.value)} aria-label="Changer d'entreprise">
      {me.companies.map((c) => <option key={c.companyId} value={c.companyId}>{c.name}</option>)}
    </select>
  );

  return (
    <Ctx.Provider value={{ me, ctx, can, refresh }}>
      <div className={home ? 'shell home' : 'shell'}>
        <header className="topbar">
          {home || !app
            ? <Link href="/app" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>Kora<span> ERP</span></Link>
            : <Link href="/app" className="app-title" title="Revenir à toutes les applications"><AppIcon name={app.key} size={26} />{app.label}</Link>}
          {pages.length > 1 && (
            <nav className="subnav" aria-label={`Menu ${app!.label}`}>
              {pages.map((p) => <Link key={p.href} href={p.href} className={p.href === activePage ? 'active' : ''} aria-current={p.href === activePage ? 'page' : undefined}>{p.label}</Link>)}
            </nav>
          )}
          <div className="row topbar-end">
            {status && <Pill tone={status[1]}>{status[0]}</Pill>}
            {companySelect && <div style={{ width: 200 }}>{companySelect}</div>}
            {me.platformRoles.length > 0 && <Link className="btn sm" href="/console">Console éditeur</Link>}
            <span className="small muted who">{me.user.fullName}</span>
            <button className="btn sm" onClick={logout}>Se déconnecter</button>
          </div>
        </header>
        <main className="main"><div className="wrap">
          {ctx?.readOnly && (
            <div className="alert warn">Votre espace est en <b>lecture seule</b> ({status?.[0].toLowerCase() ?? 'compte suspendu'}). Vous pouvez consulter et exporter vos données. {can('billing.admin') && <Link href="/app/abonnement">Régler l'abonnement</Link>}</div>
          )}
          {me.companies.length === 0 && !me.platformRoles.length && <div className="alert info">Vous n'avez accès à aucune entreprise. Créez-en une depuis le tableau de bord ou demandez une invitation.</div>}
          {children}
        </div></main>
      </div>
    </Ctx.Provider>
  );
}
