'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, money, OPENING_COUNTERPARTS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const POSTING: Record<string, [string, string]> = {
  supplier: ['Achat à comptabiliser', "D 2x (immobilisation) / C 481 Fournisseurs d'investissements, à la date d'acquisition."],
  opening: ['Bien existant avant Kora', 'Reprise en à-nouveaux : D 2x (coût) / C 28x (amortissements antérieurs) et C origine des fonds pour la valeur nette.'],
  none: ['Déjà en comptabilité', "Aucune écriture d'acquisition : le bien est déjà au compte 2x (saisie manuelle ou par le comptable)."],
};

/** Immobilisations (fonctionnalité « Immobilisations et amortissements ») : registre, plan, dotations, sortie. */
export function FixedAssets({ changed }: { changed: () => void }) {
  const { can, ctx } = useSession();
  const [data, setData] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [year, setYear] = useState(new Date().getFullYear() - (new Date().getMonth() < 3 ? 1 : 0));
  const [preview, setPreview] = useState<any>(null);
  const [dispose, setDispose] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const write = can('accounting.create') && !ctx?.readOnly;
  const validate = can('accounting.validate') && !ctx?.readOnly;
  const load = useCallback(async () => { setData(await api('/company/assets')); setPreview(await api(`/company/assets/depreciation/preview?year=${year}`)); }, [year]);
  useEffect(() => { run(load); }, [load]); // eslint-disable-line
  const open = (id: string) => run(async () => setDetail(await api(`/company/assets/${id}`)));
  const newForm = () => { setNotice(''); setForm({ name: '', category: 'vehicles', acquisitionDate: today(), inServiceDate: '', cost: '', durationMonths: 48, priorDepreciation: '', posting: 'supplier', counterpart: '121000', postingDate: '' }); };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<any>('/company/assets', { body: {
        name: form.name, category: form.category, acquisitionDate: form.acquisitionDate, ...(form.inServiceDate ? { inServiceDate: form.inServiceDate } : {}),
        cost: Number(form.cost), durationMonths: Number(form.durationMonths), posting: form.posting,
        ...(form.posting === 'opening' ? { priorDepreciation: Number(form.priorDepreciation || 0), counterpart: form.counterpart, ...(form.postingDate ? { postingDate: form.postingDate } : {}) } : {}),
      } });
      setForm(null); setNotice(`${r.code} enregistrée${r.entry ? ` — écriture ${r.entry}` : ''}.`); await load(); changed();
    });
  };
  const post = () => run(async () => { const r = await api<any>('/company/assets/depreciation', { body: { year } }); setNotice(`Dotations ${year} passées : ${money(r.total)} pour ${r.assets} bien(s), écriture ${r.number}.`); await load(); changed(); });
  const doDispose = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => { const r = await api<any>(`/company/assets/${dispose.id}/dispose`, { body: { date: dispose.date, reason: dispose.reason } }); setDispose(null); setDetail(null); setNotice(`Bien sorti de l'actif (${r.number}) : valeur nette ${money(r.netBookValue)} passée au compte 812000.`); await load(); changed(); });
  };
  if (!data) return <Alert>{error}</Alert>;
  const cat = data.categories.find((c: any) => c.key === form?.category);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      <div className="kpis">
        <div className="card kpi"><div className="l">Valeur brute</div><div className="v">{money(data.totals.cost)}</div><div className="small muted">{data.assets.filter((a: any) => !a.disposedOn).length} bien(s) à l&apos;actif</div></div>
        <div className="card kpi"><div className="l">Amortissements comptabilisés</div><div className="v">{money(data.totals.booked)}</div></div>
        <div className="card kpi"><div className="l">Valeur nette comptable</div><div className="v">{money(data.totals.netBookValue)}</div></div>
      </div>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <header><h2>Dotations aux amortissements</h2>
          <select className="input" style={{ width: 120 }} value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Exercice">
            {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() + 1 - i).map((y) => <option key={y} value={y}>{y}</option>)}</select></header>
        {preview && (preview.lines.length
          ? <><p className="small" style={{ margin: 0 }}>À passer au 31/12/{year} : <b>{money(preview.total)}</b> pour {preview.lines.length} bien(s) (D 681 / C 28x), en une écriture d&apos;OD.</p>
            <div className="table-wrap"><table><thead><tr><th>Bien</th><th>Comptes</th><th className="n">Dotation</th></tr></thead>
              <tbody>{preview.lines.map((l: any) => <tr key={l.id}><td>{l.code} · {l.name}</td><td className="small">{l.expenseAccount} / {l.depreciationAccount}</td><td className="n">{money(l.amount)}</td></tr>)}</tbody></table></div>
            {validate && <div><button className="btn primary" disabled={busy} onClick={post}>Passer les dotations {year}</button></div>}</>
          : <p className="small muted" style={{ margin: 0 }}>{preview.alreadyPosted ? `Les dotations ${year} sont passées.` : `Aucune dotation pour ${year}.`}</p>)}
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Registre des immobilisations</h2>{write && <button className="btn" onClick={newForm}>+ Nouvelle immobilisation</button>}</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Bien</th><th>Catégorie</th><th>Mise en service</th><th className="n">Durée</th><th className="n">Coût</th><th className="n">Amortissements</th><th className="n">Valeur nette</th><th /></tr></thead>
        <tbody>{data.assets.length ? data.assets.map((a: any) => (
          <tr key={a.id}><td>{a.code}</td><td><b>{a.name}</b>{a.disposedOn && <> <Pill>Sorti le {date(a.disposedOn)}</Pill></>}</td><td className="small">{a.categoryLabel}</td>
            <td>{date(a.inServiceDate)}</td><td className="n">{a.durationMonths % 12 ? `${a.durationMonths} mois` : `${a.durationMonths / 12} an${a.durationMonths > 12 ? 's' : ''}`}</td>
            <td className="n">{money(a.cost)}</td><td className="n">{money(a.booked)}</td><td className="n">{money(a.disposedOn ? 0 : a.netBookValue)}</td>
            <td><button className="btn sm" onClick={() => open(a.id)}>Plan</button></td></tr>
        )) : <tr><td colSpan={9} className="muted">Aucune immobilisation. Enregistrez vos véhicules, matériels, mobilier ou logiciels de plus de 12 mois d&apos;usage.</td></tr>}</tbody>
      </table></div>

      {detail && <div className="modal-back" onClick={() => setDetail(null)}><div className="modal" onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gap: 10, maxWidth: 720 }}>
        <h2>{detail.code} · {detail.name}</h2>
        <p className="small muted" style={{ margin: 0 }}>{detail.categoryLabel} — comptes {detail.assetAccount} / {detail.depreciationAccount}. Coût {money(detail.cost)}, mise en service le {date(detail.inServiceDate)}, amorti en linéaire jusqu&apos;au {date(detail.endOfLife)}.</p>
        <div className="table-wrap"><table><thead><tr><th>Exercice</th><th className="n">Dotation</th><th className="n">Cumul</th><th className="n">Valeur nette</th><th>État</th></tr></thead>
          <tbody>{detail.schedule.map((r: any) => <tr key={r.year}><td>{r.year}</td><td className="n">{money(r.dotation)}</td><td className="n">{money(r.cumulative)}</td><td className="n">{money(r.netValue)}</td>
            <td>{r.status === 'posted' ? <Pill tone="ok">Comptabilisée</Pill> : r.status === 'prior' ? <Pill>Avant Kora</Pill> : <Pill tone="warn">À passer</Pill>}</td></tr>)}</tbody></table></div>
        <div className="row">
          {validate && !detail.disposedOn && <button className="btn danger" onClick={() => setDispose({ id: detail.id, name: detail.name, date: today(), reason: '' })}>Sortir de l&apos;actif</button>}
          <button className="btn" onClick={() => setDetail(null)}>Fermer</button></div>
      </div></div>}

      {dispose && <div className="modal-back" onClick={() => setDispose(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={doDispose} style={{ display: 'grid', gap: 10 }}>
        <h2>Sortir « {dispose.name} » de l&apos;actif</h2>
        <p className="small muted" style={{ margin: 0 }}>Cession, mise au rebut, vol ou destruction. Kora passe la dotation complémentaire jusqu&apos;à cette date, puis D 28x et D 812000 (valeur nette) / C 2x. Si le bien est vendu, enregistrez le prix de vente en produit au compte 822000 (facture ou écriture d&apos;OD).</p>
        <Field label="Date de sortie" type="date" required value={dispose.date} onChange={(e) => setDispose({ ...dispose, date: e.target.value })} />
        <Field label="Motif" required minLength={3} placeholder="Ex. vendu à un particulier, épave après accident" value={dispose.reason} onChange={(e) => setDispose({ ...dispose, reason: e.target.value })} />
        <div className="row"><button className="btn danger" disabled={busy}>Confirmer la sortie</button><button type="button" className="btn" onClick={() => setDispose(null)}>Annuler</button></div>
      </form></div>}

      {form && <div className="modal-back" onClick={() => setForm(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save} style={{ display: 'grid', gap: 10 }}>
        <h2>Nouvelle immobilisation</h2>
        <div className="grid2">
          <Field label="Désignation du bien" required minLength={2} placeholder="Ex. Camion Isuzu NPR AB-1234-CI" value={form.name} onChange={set('name')} />
          <label className="field">Catégorie<select className="input" value={form.category} onChange={(e) => { const c = data.categories.find((x: any) => x.key === e.target.value); setForm({ ...form, category: e.target.value, durationMonths: c.years * 12 }); }}>
            {data.categories.map((c: any) => <option key={c.key} value={c.key}>{c.label} ({c.asset})</option>)}</select></label>
          <Field label="Coût d'acquisition HT (FCFA)" type="number" min={1} step="any" required value={form.cost} onChange={set('cost')} />
          <Field label="Durée d'amortissement (mois)" type="number" min={1} max={1200} required value={form.durationMonths} onChange={set('durationMonths')} />
          <Field label="Date d'acquisition" type="date" required value={form.acquisitionDate} onChange={set('acquisitionDate')} />
          <Field label="Mise en service (vide : acquisition)" type="date" value={form.inServiceDate} onChange={set('inServiceDate')} />
        </div>
        {cat && <p className="small muted" style={{ margin: 0 }}>Durée usuelle : {cat.years} ans. Amortissement linéaire au prorata temporis, comptes {cat.asset} / {cat.depreciation} / {cat.expense}.</p>}
        <label className="field">Comptabilisation de l&apos;acquisition<select className="input" value={form.posting} onChange={set('posting')}>{Object.entries(POSTING).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
          <span className="small muted">{POSTING[form.posting][1]}</span></label>
        {form.posting === 'opening' && <div className="grid2">
          <Field label="Amortissements déjà pratiqués (FCFA)" type="number" min={0} step="any" value={form.priorDepreciation} onChange={set('priorDepreciation')} />
          <Field label="Date de la reprise (vide : aujourd'hui)" type="date" value={form.postingDate} onChange={set('postingDate')} />
          <label className="field">Origine des fonds<select className="input" value={form.counterpart} onChange={set('counterpart')}>
            {OPENING_COUNTERPARTS.filter(([c]) => c !== '401000').map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></label>
        </div>}
        <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setForm(null)}>Annuler</button></div>
      </form></div>}
    </div>
  );
}
