'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Alert, Pill, useAction } from '@/components/ui';

/** Nouveautés de Kora et entreprises où elles sont activées (activation à la demande de chaque client). */
export default function FeaturesOverview() {
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState('');
  const { error, run } = useAction();
  useEffect(() => { run(async () => setData(await api('/platform/features'))); }, []); // eslint-disable-line
  const shown = (data?.companies ?? []).filter((c: any) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="page-head"><h1>Fonctionnalités</h1></div>
      <p className="muted" style={{ margin: 0 }}>Les nouveautés de Kora sont désactivées pour toutes les entreprises. Activez-les une par une, quand un client le demande, avec le bouton <b>Gérer</b> de son entreprise. Une fonctionnalité déjà utilisée par un client ne peut plus lui être retirée.</p>
      <Alert>{error}</Alert>
      {data && <>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          {data.features.map((f: any) => (
            <div key={f.key} className="card" style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              <header><h2 style={{ fontSize: 16 }}>{f.label}</h2><Pill>{`v${f.version}`}</Pill></header>
              <p className="small" style={{ margin: 0 }}>{f.description}</p>
              <div className="small muted">{f.companies ? `Activée pour ${f.companies} entreprise${f.companies > 1 ? 's' : ''}` : 'Activée nulle part'}</div>
            </div>
          ))}
        </div>
        <div className="row"><input className="input" style={{ maxWidth: 320 }} placeholder="Rechercher une entreprise" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une entreprise" /></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Entreprise</th>{data.features.map((f: any) => <th key={f.key} className="small" style={{ textAlign: 'center' }}>{f.label}</th>)}<th /></tr></thead>
          <tbody>{shown.map((c: any) => (
            <tr key={c.id}><td><b>{c.name}</b>{c.status !== 'active' && <> <Pill tone="crit">Suspendue</Pill></>}</td>
              {data.features.map((f: any) => <td key={f.key} style={{ textAlign: 'center' }}>{c.enabled.includes(f.key) ? <Pill tone="ok">Activée</Pill> : <span className="muted">—</span>}</td>)}
              <td className="n"><Link className="btn sm primary" href={`/console/fonctionnalites/${c.id}`}>Gérer</Link></td></tr>
          ))}</tbody>
        </table></div>
      </>}
    </>
  );
}
