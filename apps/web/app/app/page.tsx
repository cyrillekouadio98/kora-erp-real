'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AppIcon, APPS } from '@/components/apps';
import { useSession } from '@/components/session';

/** Écran d'accueil : la grille des applications accessibles à l'utilisateur. */
export default function Home() {
  const { me, ctx, can } = useSession();
  const [q, setQ] = useState('');
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const apps = APPS.filter((a) => (!a.perm || can(a.perm)) && (!a.module || ctx?.entitlements.modules.includes(a.module)))
    .filter((a) => norm(a.label).includes(norm(q.trim())));
  const company = me.companies.find((c) => c.companyId === me.activeCompanyId)?.name;

  return (
    <div className="launcher">
      <div className="launcher-head">
        <h1>Bonjour {me.user.fullName.split(' ')[0]}</h1>
        {company && <p className="muted" style={{ margin: 0 }}>{company}</p>}
        <input className="input" type="search" placeholder="Rechercher une application…" aria-label="Rechercher une application" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && apps[0]) (document.querySelector('.apps a') as HTMLElement | null)?.click(); }} />
      </div>
      <nav className="apps" aria-label="Applications">
        {apps.map((a) => (
          <Link key={a.key} href={a.href} className="app">
            <span className="app-ico"><AppIcon name={a.key} /></span>
            <span className="app-name">{a.label}</span>
          </Link>
        ))}
        {!apps.length && <p className="muted">Aucune application ne correspond à « {q} ».</p>}
      </nav>
    </div>
  );
}
