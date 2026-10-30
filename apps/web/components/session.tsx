'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { SUB_STATUS } from '@/lib/format';
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

/** module : entrée masquée si le module n'est pas inclus dans la formule. */
const NAV: { href: string; label: string; perm?: string; module?: string; group: string }[] = [
  { href: '/app', label: 'Tableau de bord', group: 'Entreprise' },
  { href: '/app/entreprise', label: 'Fiche entreprise', perm: 'settings.read', group: 'Entreprise' },
  { href: '/app/ventes/devis', label: 'Devis', perm: 'sales.read', group: 'Ventes' },
  { href: '/app/ventes/factures', label: 'Factures', perm: 'sales.read', group: 'Ventes' },
  { href: '/app/ventes/avoirs', label: 'Avoirs', perm: 'sales.read', group: 'Ventes' },
  { href: '/app/ventes/relances', label: 'Relances clients', perm: 'sales.read', group: 'Ventes' },
  { href: '/app/achats/commandes', label: 'Bons de commande', perm: 'purchases.read', module: 'purchases', group: 'Achats' },
  { href: '/app/achats/factures', label: 'Factures fournisseurs', perm: 'purchases.read', module: 'purchases', group: 'Achats' },
  { href: '/app/achats/echeancier', label: 'Échéancier', perm: 'purchases.read', module: 'purchases', group: 'Achats' },
  { href: '/app/tresorerie', label: 'Trésorerie', perm: 'cash.read', module: 'cash', group: 'Finance' },
  { href: '/app/tresorerie/caisse', label: 'Caisse', perm: 'cash.read', module: 'cash', group: 'Finance' },
  { href: '/app/tresorerie/banque', label: 'Banque', perm: 'cash.read', module: 'cash', group: 'Finance' },
  { href: '/app/tresorerie/mobile-money', label: 'Mobile money', perm: 'cash.read', module: 'cash', group: 'Finance' },
  { href: '/app/comptabilite', label: 'Comptabilité', perm: 'accounting.read', module: 'accounting', group: 'Finance' },
  { href: '/app/employes', label: 'Employés', perm: 'employees.read', module: 'hr', group: 'Ressources humaines' },
  { href: '/app/conges', label: 'Congés', perm: 'leave.read', module: 'hr', group: 'Ressources humaines' },
  { href: '/app/paie', label: 'Paie', perm: 'payroll.read', module: 'payroll', group: 'Ressources humaines' },
  { href: '/app/contacts', label: 'Clients et fournisseurs', perm: 'contacts.read', group: 'Référentiels' },
  { href: '/app/articles', label: 'Articles', perm: 'products.read', group: 'Référentiels' },
  { href: '/app/stocks', label: 'Stocks', perm: 'products.read', group: 'Référentiels' },
  { href: '/app/utilisateurs', label: 'Utilisateurs', perm: 'users.read', group: 'Administration' },
  { href: '/app/roles', label: 'Rôles et permissions', perm: 'users.read', group: 'Administration' },
  { href: '/app/abonnement', label: 'Abonnement', perm: 'billing.read', group: 'Administration' },
  { href: '/app/journal', label: "Journal d'audit", perm: 'audit.read', group: 'Administration' },
  { href: '/app/emails', label: 'E-mails envoyés', perm: 'settings.read', group: 'Administration' },
  { href: '/app/support', label: 'Accès du support', perm: 'settings.admin', group: 'Administration' },
  { href: '/app/moi', label: 'Mon espace', perm: 'employees.self', module: 'hr', group: 'Mon compte' },
  { href: '/app/securite', label: 'Ma sécurité', group: 'Mon compte' },
];

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
  // L'entrée la plus précise : sur /app/tresorerie/caisse, « Caisse » et pas « Trésorerie ».
  const activeHref = NAV.map((n) => n.href).filter((h) => path === h || (h !== '/app' && path.startsWith(`${h}/`))).sort((x, y) => y.length - x.length)[0];
  let group = '';

  return (
    <Ctx.Provider value={{ me, ctx, can, refresh }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">Kora<span> ERP</span></div>
          {me.companies.length > 0 && (
            <label className="field" style={{ padding: '0 8px' }}>Entreprise active
              <select className="input" value={me.activeCompanyId ?? ''} onChange={(e) => switchTo(e.target.value)} aria-label="Changer d'entreprise">
                {me.companies.map((c) => <option key={c.companyId} value={c.companyId}>{c.name}</option>)}
              </select>
            </label>
          )}
          <nav className="nav" aria-label="Navigation principale">
            {NAV.filter((n) => (!n.perm || can(n.perm)) && (!n.module || ctx?.entitlements.modules.includes(n.module))).map((n) => {
              const head = n.group !== group ? <small key={`g-${n.group}`}>{(group = n.group)}</small> : null;
              return [head, <Link key={n.href} href={n.href} className={n.href === activeHref ? 'active' : ''}>{n.label}</Link>];
            })}
            {me.platformRoles.length > 0 && [<small key="g-p">Éditeur</small>, <Link key="console" href="/console">Console éditeur</Link>]}
          </nav>
          <div className="foot">
            {status && <div><Pill tone={status[1]}>{status[0]}</Pill></div>}
            <div className="muted">{me.user.fullName}<br />{me.user.email}</div>
            <button className="btn sm" onClick={logout}>Se déconnecter</button>
          </div>
        </aside>
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
