'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, money, SETUP_STATUS } from '@/lib/format';
import { Alert, Field, Pill, useAction } from '@/components/ui';

/** Console : entreprises préparées pour des clients, et lancement d'une nouvelle préparation. */
export default function PreparationList() {
  const router = useRouter();
  const [rows, setRows] = useState<any[] | null>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => run(async () => setRows(await api('/platform/setup'))), []); // eslint-disable-line
  useEffect(() => { load(); api('/plans').then((p) => setPlans(p.filter((x: any) => x.priceMonthly > 0)), () => {}); }, [load]);

  return (
    <>
      <div className="page-head"><h1>Préparer une entreprise</h1>
        <button className="btn primary" onClick={() => setForm({ name: '', legalForm: '', city: '', planCode: 'business', billingCycle: 'monthly' })}>Nouvelle entreprise</button></div>
      <p className="small muted" style={{ margin: 0 }}>
        Pour un client qui souhaite la solution : vous créez son entreprise, choisissez la formule, paramétrez la fiche, les sites, les comptes de trésorerie et les utilisateurs,
        puis vous la lui <b>remettez</b>. Il reçoit alors une invitation de propriétaire, et la console perd l&apos;accès au contenu de l&apos;entreprise.
      </p>
      <Alert>{!form && error}</Alert>

      {rows && !rows.length && <div className="card empty-state"><p>Aucune entreprise préparée pour l&apos;instant.</p></div>}
      {rows && rows.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>Entreprise</th><th>Formule</th><th>Propriétaire</th><th>État</th><th>Préparée par</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => router.push(`/console/preparation/${r.id}`)}>
            <td><Link href={`/console/preparation/${r.id}`} onClick={(e) => e.stopPropagation()}><b>{r.name}</b></Link><div className="small muted">{r.city}</div></td>
            <td>{r.planName}</td>
            <td>{r.ownerEmail ? <>{r.ownerName}<div className="small muted">{r.ownerEmail}</div></> : <span className="muted">À indiquer</span>}</td>
            <td><Pill tone={SETUP_STATUS[r.status][1]}>{SETUP_STATUS[r.status][0]}</Pill>{r.handedOverAt && <div className="small muted">remise le {date(r.handedOverAt)}</div>}</td>
            <td className="small">{r.preparedBy}<div className="muted">{date(r.createdAt)}</div></td>
          </tr>))}</tbody>
      </table></div>}

      {form && (
        <div className="modal-back" onClick={() => setForm(null)}>
          <form className="modal" style={{ width: 'min(560px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { const r = await api('/platform/setup', { body: form }); router.push(`/console/preparation/${r.id}`); });
          }}>
            <h2>Nouvelle entreprise</h2>
            <Alert>{error}</Alert>
            <Field label="Raison sociale" required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="grid2">
              <Field label="Forme juridique" placeholder="SARL, SA, SAS…" value={form.legalForm} onChange={(e) => setForm({ ...form, legalForm: e.target.value })} />
              <Field label="Ville" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <label className="field">Formule<select className="input" value={form.planCode} onChange={(e) => setForm({ ...form, planCode: e.target.value })}>
              {plans.map((p) => <option key={p.code} value={p.code}>{p.name} — {money(p.priceMonthly)} / mois · {p.entitlements.quotas.users ?? 'utilisateurs illimités'}{p.entitlements.quotas.users ? ' utilisateurs' : ''}</option>)}
            </select></label>
            <div className="row small"><label className="row"><input type="radio" checked={form.billingCycle === 'monthly'} onChange={() => setForm({ ...form, billingCycle: 'monthly' })} /> Mensuel</label>
              <label className="row"><input type="radio" checked={form.billingCycle === 'yearly'} onChange={() => setForm({ ...form, billingCycle: 'yearly' })} /> Annuel (2 mois offerts)</label></div>
            <p className="small muted" style={{ margin: 0 }}>Le site principal, une caisse, un compte bancaire et un compte mobile money sont créés d&apos;office ; vous les complétez à l&apos;étape suivante.</p>
            <div className="row"><button className="btn primary" disabled={busy}>Créer et paramétrer</button><button type="button" className="btn" onClick={() => setForm(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
