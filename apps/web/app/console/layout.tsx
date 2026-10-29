'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<any>(null);
  useEffect(() => { api('/auth/me').then(setMe, (e) => e instanceof ApiError && e.status === 401 && router.replace('/connexion')); }, [router]);
  if (!me) return <main className="auth"><p className="muted">Chargement…</p></main>;
  if (!me.platformRoles.length) return <main className="auth"><div className="alert err">Cette console est réservée à l'équipe de l'éditeur.</div></main>;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Kora<span> Console</span></div>
        <nav className="nav">
          <small>Éditeur</small>
          <Link href="/console" className={path === '/console' ? 'active' : ''}>Clients et indicateurs</Link>
          <Link href="/console/factures" className={path === '/console/factures' ? 'active' : ''}>Factures d'abonnement</Link>
          {me.companies.length > 0 && <><small>Mon entreprise</small><Link href="/app">Espace entreprise</Link></>}
        </nav>
        <div className="foot"><div className="muted">{me.user.fullName}<br />Rôles : {me.platformRoles.join(', ')}</div>
          {!me.user.mfaEnabled && <Link href="/app/securite" className="small">Activer la double authentification (obligatoire)</Link>}
          <button className="btn sm" onClick={async () => { await api('/auth/logout', { method: 'POST', body: {} }); router.replace('/connexion'); }}>Se déconnecter</button></div>
      </aside>
      <main className="main"><div className="wrap">{children}</div></main>
    </div>
  );
}
