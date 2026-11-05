'use client';
import { useState } from 'react';
import { useSession } from '@/components/session';
import { Markdown } from '@/components/markdown';
import { Pill } from '@/components/ui';
import { date } from '@/lib/format';
import { MANUAL, MANUAL_UPDATED } from '@/lib/manual';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Manuel de procédures : sommaire, recherche et impression ; la partie éditeur n'est montrée qu'à l'équipe N'Ora. */
export default function ManualPage() {
  const { me, ctx } = useSession();
  const [q, setQ] = useState('');
  const sections = MANUAL.filter((s) => !s.platformOnly || me.platformRoles.length > 0);
  const words = norm(q.trim()).split(/\s+/).filter(Boolean);
  const shown = sections.filter((s) => words.every((w) => norm(`${s.title} ${s.body}`).includes(w)));
  const outside = (module?: string) => !!module && !!ctx && !ctx.entitlements.modules.includes(module);

  return (
    <>
      <div className="page-head no-print">
        <div><h1>Manuel de procédures</h1><p className="small muted" style={{ margin: 0 }}>Qui fait quoi dans N'Ora, étape par étape · mis à jour le {date(MANUAL_UPDATED)}</p></div>
        <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button>
      </div>
      <div className="manual">
        <nav className="card manual-toc no-print" aria-label="Sommaire">
          <input className="input" type="search" placeholder="Rechercher (ex. avoir, arrêté de caisse)…" aria-label="Rechercher dans le manuel" value={q} onChange={(e) => setQ(e.target.value)} />
          {words.length > 0 && <p className="small muted" style={{ margin: 0 }}>{shown.length ? `${shown.length} section${shown.length > 1 ? 's' : ''} trouvée${shown.length > 1 ? 's' : ''}` : 'Aucune section ne correspond.'}</p>}
          <ol>{shown.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}{outside(s.module) && <span className="small muted"> · hors formule</span>}</a></li>)}</ol>
        </nav>
        <div className="manual-body">
          {shown.map((s) => (
            <section key={s.id} id={s.id} className="card manual-section">
              <h2>{s.title} {outside(s.module) && <Pill>Hors de votre formule</Pill>} {s.platformOnly && <Pill tone="warn">Équipe N'Ora</Pill>}</h2>
              <Markdown text={s.body} idPrefix={s.id} />
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
