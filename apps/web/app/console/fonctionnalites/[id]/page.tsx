'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

/** Nouveautés d'une entreprise : désactivées par défaut, activées à la demande du client. */
export default function CompanyFeatures() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setData(await api(`/platform/companies/${id}/features`)), [id]);
  useEffect(() => { run(load); }, [load]); // eslint-disable-line
  const apply = (f: any) => run(async () => {
    await api(`/platform/companies/${id}/features/${f.key}`, { method: 'PUT', body: { enabled: !f.enabled } });
    setConfirm(null); setNotice(`« ${f.label} » ${f.enabled ? 'désactivée' : 'activée'} pour ${data.company.name}.`); await load();
  });
  return (
    <>
      <div className="page-head"><h1>Fonctionnalités{data && <> · {data.company.name}</>}</h1><Link className="btn sm" href="/console">Retour aux clients</Link></div>
      <p className="muted" style={{ margin: 0 }}>Les nouveautés de Kora sont désactivées pour toutes les entreprises. Activez-les ici, une par une, quand le client le demande : ses utilisateurs voient la fonction dès leur prochaine page. Une fonctionnalité déjà utilisée ne peut plus être retirée.</p>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      {data && <div style={{ display: 'grid', gap: 12 }}>
        {data.features.map((f: any) => (
          <div key={f.key} className="card" style={{ display: 'grid', gap: 10 }}>
            <header><h2>{f.label}</h2>{f.enabled ? <Pill tone="ok">Activée</Pill> : <Pill>Désactivée</Pill>}</header>
            <p className="small" style={{ margin: 0 }}>{f.description}</p>
            <div className="small muted">Version {f.version}{f.enabled && <> · activée le {date(f.enabledAt)}{f.enabledBy && <> par {f.enabledBy}</>}</>}{f.inUse && <> · déjà utilisée</>}</div>
            {confirm?.key === f.key ? (
              <div className="row" style={{ alignItems: 'center' }}>
                <span className="small"><b>{f.enabled ? 'Désactiver' : 'Activer'} pour {data.company.name} ?</b></span>
                <button className={`btn sm ${f.enabled ? 'danger' : 'primary'}`} disabled={busy} onClick={() => apply(f)}>Confirmer</button>
                <button className="btn sm" disabled={busy} onClick={() => setConfirm(null)}>Annuler</button>
              </div>
            ) : (
              <div>{f.enabled
                ? <button className="btn sm" disabled={busy || f.inUse} title={f.inUse ? 'Déjà utilisée par le client' : undefined} onClick={() => { setNotice(''); setConfirm(f); }}>Désactiver</button>
                : <button className="btn sm primary" disabled={busy} onClick={() => { setNotice(''); setConfirm(f); }}>Activer</button>}</div>
            )}
          </div>
        ))}
      </div>}
    </>
  );
}
