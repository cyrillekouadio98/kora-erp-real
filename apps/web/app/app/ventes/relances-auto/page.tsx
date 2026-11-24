'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const TAGS = ['{client}', '{facture}', '{montant}', '{echeance}', '{jours}', '{entreprise}'];

/** Relances automatiques des factures en retard : étapes, messages et aperçu de la tournée du jour. */
export default function AutoRemindersPage() {
  const { has, can, ctx } = useSession();
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const write = can('sales.update') && !ctx?.readOnly;
  const load = async () => { const d = await api<any>('/company/dunning'); setData(d); setForm({ enabled: d.configured ? d.enabled : true, copyTo: d.copyTo ?? '', steps: d.steps.map((s: any) => ({ ...s })) }); };
  useEffect(() => { if (has('auto_reminders')) run(load); }, []); // eslint-disable-line
  if (!has('auto_reminders')) return <Alert kind="warn">Les relances automatiques ne sont pas activées pour votre entreprise. Contactez Kora ERP pour les activer.</Alert>;
  if (!data || !form) return <Alert>{error}</Alert>;
  const setStep = (i: number, patch: any) => setForm({ ...form, steps: form.steps.map((s: any, j: number) => (j === i ? { ...s, ...patch } : s)) });
  const save = (e: React.FormEvent) => { e.preventDefault(); setNotice(''); run(async () => {
    await api('/company/dunning', { method: 'PUT', body: { enabled: form.enabled, copyTo: form.copyTo || null, steps: form.steps.map((s: any) => ({ days: Number(s.days), subject: s.subject, message: s.message })) } });
    setNotice(form.enabled ? 'Relances automatiques enregistrées : elles partiront chaque matin vers 8 h.' : 'Relances automatiques arrêtées.'); await load(); }); };
  const sendNow = () => run(async () => { const r = await api<any>('/company/dunning/run', { body: {} }); setNotice(`${r.sent} relance(s) envoyée(s).`); await load(); });
  const ready = data.preview.filter((p: any) => !p.skip);
  return (
    <>
      <div className="page-head"><h1>Relances automatiques</h1>{data.configured ? (data.enabled ? <Pill tone="ok">Actives</Pill> : <Pill>Arrêtées</Pill>) : <Pill tone="warn">À régler</Pill>}</div>
      <p className="muted" style={{ margin: 0 }}>Chaque matin vers 8 h, Kora envoie par e-mail aux clients en retard l&apos;étape de relance qu&apos;ils ont atteinte, avec un lien vers la facture. Une étape n&apos;est jamais envoyée deux fois ; un client qui a promis une date de paiement (relance notée dans <Link href="/app/ventes/relances">Relances clients</Link>) n&apos;est pas relancé avant cette date. Chaque envoi est noté sur la facture.</p>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      <form className="card" onSubmit={save} style={{ display: 'grid', gap: 12 }}>
        <header><h2>Réglages</h2>{data.lastRunOn && <span className="small muted">dernière tournée le {date(data.lastRunOn)}</span>}</header>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" disabled={!write} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> <b>Envoyer les relances automatiquement</b></label>
        <Field label="Copie de chaque relance à (facultatif)" type="email" disabled={!write} placeholder="Ex. compta@votre-entreprise.ci" value={form.copyTo} onChange={(e) => setForm({ ...form, copyTo: e.target.value })} />
        {form.steps.map((s: any, i: number) => (
          <fieldset key={i} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
            <legend className="small" style={{ fontWeight: 600 }}>Étape {i + 1}</legend>
            <div className="row" style={{ gap: 8, alignItems: 'end' }}>
              <Field label="Jours après l'échéance" type="number" min={1} max={365} required disabled={!write} value={s.days} onChange={(e) => setStep(i, { days: e.target.value })} style={{ width: 110 }} />
              <div style={{ flex: 1, minWidth: 220 }}><Field label="Objet de l'e-mail" required disabled={!write} value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} /></div>
              {write && form.steps.length > 1 && <button type="button" className="btn sm danger" onClick={() => setForm({ ...form, steps: form.steps.filter((_: any, j: number) => j !== i) })} aria-label={`Retirer l'étape ${i + 1}`}>✕</button>}
            </div>
            <label className="field">Message<textarea className="input" rows={6} required disabled={!write} value={s.message} onChange={(e) => setStep(i, { message: e.target.value })} /></label>
          </fieldset>
        ))}
        <p className="small muted" style={{ margin: 0 }}>Champs remplacés dans l&apos;objet et le message : {TAGS.join(' ')}.</p>
        {write && <div className="row">
          {form.steps.length < 5 && <button type="button" className="btn sm" onClick={() => setForm({ ...form, steps: [...form.steps, { days: (Number(form.steps.at(-1)?.days) || 0) + 15, subject: 'Relance — facture {facture}', message: 'Bonjour {client},\n\nLa facture {facture} ({montant}) reste impayée depuis {jours} jours.\n\nCordialement,\n{entreprise}' }] })}>+ Ajouter une étape</button>}
          <button type="button" className="btn sm" onClick={() => setForm({ ...form, steps: data.defaults.map((s: any) => ({ ...s })) })}>Reprendre les messages proposés</button>
          <button className="btn primary" disabled={busy}>Enregistrer</button></div>}
      </form>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <header><h2>Tournée d&apos;aujourd&apos;hui</h2>{write && data.configured && data.enabled && ready.length > 0 && <button className="btn" disabled={busy} onClick={sendNow}>Envoyer maintenant ({ready.length})</button>}</header>
        <div className="table-wrap"><table>
          <thead><tr><th>Facture</th><th>Client</th><th>Échéance</th><th className="n">Retard</th><th className="n">Reste dû</th><th>Relance</th></tr></thead>
          <tbody>{data.preview.length ? data.preview.map((p: any) => (
            <tr key={p.id}><td><Link href={`/app/ventes/${p.id}`}>{p.number}</Link></td><td>{p.customer}</td><td>{date(p.dueDate)}</td><td className="n">{p.daysLate} j</td><td className="n">{money(p.remaining)}</td>
              <td>{p.skip ? <span className="small muted">{p.skip}</span> : <Pill tone="warn">Étape {p.step} à envoyer</Pill>}</td></tr>
          )) : <tr><td colSpan={6} className="muted">Aucune facture en retard.</td></tr>}</tbody>
        </table></div>
      </div>
    </>
  );
}
