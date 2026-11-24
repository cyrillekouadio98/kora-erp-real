'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { ACCOUNT_KINDS, date, EXPENSE_CATEGORIES, INCOME_CATEGORIES, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { ImportButton, ImportConfig } from '@/components/import';
import { Alert, Pill, useAction } from '@/components/ui';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Relevé de banque ou de mobile money : colonnes reconnues, montant signé (crédit − débit). */
function statementImport(account: { id: string; name: string }): ImportConfig {
  return {
    title: `Importer un relevé — ${account.name}`, what: 'relevés', one: 'relevé',
    intro: <><p>Le fichier exporté par la banque (Excel, CSV ou PDF) : une ligne par opération. Kora pointe aussitôt les lignes dont le montant et la date (à 7 jours près) correspondent à un seul mouvement.</p>
      <p>Colonnes reconnues : <b>Date</b>, <b>Libellé</b>, et soit <b>Montant</b> (négatif pour une sortie), soit <b>Débit</b> et <b>Crédit</b>. Référence facultative. Une ligne déjà importée est écartée.</p></>,
    fields: [
      { key: 'date', label: 'Date', type: 'date', required: true, aliases: ['date operation', 'date opération', 'date de valeur', 'date valeur', 'date comptable'] },
      { key: 'label', label: 'Libellé', required: true, aliases: ['libelle', 'description', 'operation', 'opération', 'motif', 'detail', 'details'] },
      { key: 'amount', label: 'Montant', type: 'number', aliases: ['montant', 'somme', 'valeur'] },
      { key: 'debit', label: 'Débit', type: 'number', aliases: ['debit', 'sortie', 'retrait', 'montant debit'] },
      { key: 'credit', label: 'Crédit', type: 'number', aliases: ['credit', 'entree', 'entrée', 'versement', 'montant credit'] },
      { key: 'reference', label: 'Référence', aliases: ['reference', 'ref', 'n piece', 'numero', 'numéro', 'transaction'] },
    ],
    check: (r) => {
      const amount = r.amount !== undefined ? r.amount : (r.credit ?? 0) - (r.debit ?? 0);
      if (!amount) return { skip: 'Montant nul (solde, report ou titre)' };
      r.signed = round2(amount);
    },
    group: (rows) => (rows.length ? [rows] : []),
    partial: true,
    save: async (g) => {
      const r = await api<any>('/company/treasury/reconciliation/import', { body: { accountId: account.id, lines: g.map((x) => ({ date: x.date, label: String(x.label).slice(0, 300), amount: x.signed, reference: x.reference ? String(x.reference).slice(0, 100) : null })) } });
      return `${r.imported} ligne(s) importée(s), ${r.duplicates} déjà présente(s), ${r.matched} pointée(s) automatiquement`;
    },
    template: { file: 'modele-releve-bancaire.csv', rows: [['Date', 'Libellé', 'Débit', 'Crédit', 'Référence'], ['03/11/2026', 'VIR RECU CLIENT KONE', '', 250000, 'VIR-8812'], ['05/11/2026', 'FRAIS TENUE DE COMPTE', 3500, '', '']] },
  };
}

/** Rapprochement bancaire : chaque ligne du relevé est pointée avec un mouvement de Kora (fonctionnalité activée à la demande). */
export default function ReconciliationPage() {
  const { can, has, ctx } = useSession();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('pending');
  const [record, setRecord] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const write = can('cash.create') && !ctx?.readOnly;
  const load = useCallback(async () => { if (accountId) setData(await api(`/company/treasury/reconciliation?accountId=${accountId}`)); }, [accountId]);
  useEffect(() => {
    if (!has('bank_reconciliation')) return;
    run(async () => { const a = (await api<any[]>('/company/treasury/accounts')).filter((x) => x.kind !== 'cash'); setAccounts(a); if (a[0]) setAccountId(a[0].id); });
  }, []); // eslint-disable-line
  useEffect(() => { run(load); }, [load]); // eslint-disable-line
  const account = accounts.find((a) => a.id === accountId);
  const config = useMemo(() => (account ? statementImport(account) : null), [account]);
  if (!has('bank_reconciliation')) return <Alert kind="warn">Le rapprochement bancaire n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;

  const act = (fn: () => Promise<unknown>, msg?: string) => run(async () => { await fn(); setNotice(msg ?? ''); await load(); });
  const lines = (data?.lines ?? []).filter((l: any) => filter === 'all' || l.status === filter);
  const s = data?.summary;
  return (
    <>
      <div className="page-head"><h1>Rapprochement bancaire</h1>
        <div className="row">
          <select className="input" style={{ width: 240 }} value={accountId} onChange={(e) => { setAccountId(e.target.value); setNotice(''); }} aria-label="Compte">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({ACCOUNT_KINDS[a.kind]})</option>)}</select>
          {write && config && <ImportButton config={config} label="Importer un relevé" onDone={() => run(load)} />}
        </div></div>
      <p className="muted" style={{ margin: 0 }}>Importez le relevé de la banque ou du mobile money, puis pointez chaque ligne avec le mouvement correspondant de Kora. Une ligne du relevé absente de Kora (frais, agios, virement reçu) s&apos;enregistre d&apos;un clic. Le pointage ne modifie aucun mouvement ni aucune écriture.</p>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      {!accounts.length && <Alert kind="warn">Aucun compte bancaire ou mobile money : créez-en un dans Trésorerie.</Alert>}
      {data && <>
        <div className="kpis">
          <div className="card kpi"><div className="l">Solde dans Kora</div><div className="v">{money(data.account.balance)}</div><div className="small muted">{s.from ? `relevé du ${date(s.from)} au ${date(s.to)}` : 'aucun relevé importé'}</div></div>
          <div className="card kpi"><div className="l">Lignes à pointer</div><div className="v" style={{ color: s.pending ? 'var(--warn)' : 'var(--ok)' }}>{s.pending}</div><div className="small muted">{money(s.pendingAmount)}</div></div>
          <div className="card kpi"><div className="l">Lignes pointées</div><div className="v">{s.matched}</div><div className="small muted">{s.ignored} écartée(s)</div></div>
          <div className="card kpi"><div className="l">Mouvements Kora absents du relevé</div><div className="v" style={{ color: s.unmatchedMovements ? 'var(--warn)' : undefined }}>{s.unmatchedMovements}</div><div className="small muted">{money(s.unmatchedAmount)}</div></div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 200 }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Lignes affichées">
            <option value="pending">À pointer</option><option value="matched">Pointées</option><option value="ignored">Écartées</option><option value="all">Toutes</option></select>
          {write && s.pending > 0 && <button className="btn" disabled={busy} onClick={() => act(async () => { const r = await api<any>('/company/treasury/reconciliation/auto', { body: { accountId } }); setNotice(`${r.matched} ligne(s) pointée(s) automatiquement.`); }, undefined)}>Pointer automatiquement</button>}
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Libellé du relevé</th><th className="n">Montant</th><th>Mouvement de Kora</th><th /></tr></thead>
          <tbody>{lines.length ? lines.map((l: any) => (
            <tr key={l.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{date(l.date)}</td>
              <td>{l.label}{l.reference && <div className="small muted">Réf. {l.reference}</div>}</td>
              <td className="n" style={{ whiteSpace: 'nowrap', color: l.amount < 0 ? 'var(--crit)' : 'var(--ok)' }}>{money(l.amount)}</td>
              <td>{l.status === 'matched' ? <><Pill tone="ok">Pointée</Pill> <span className="small">{l.movement.label} · {date(l.movement.date)}</span></>
                : l.status === 'ignored' ? <Pill>Écartée</Pill>
                : l.suggestions.length ? <div style={{ display: 'grid', gap: 4 }}>{l.suggestions.map((m: any) => (
                  <div key={m.id} className="row small" style={{ gap: 6 }}><span>{m.label} · {date(m.date)}{m.gapDays ? ` (${m.gapDays} j d'écart)` : ''}</span>
                    {write && <button className="btn sm" disabled={busy} onClick={() => act(() => api(`/company/treasury/reconciliation/lines/${l.id}/match`, { body: { movementId: m.id } }))}>Pointer</button>}</div>))}</div>
                : <span className="small muted">Aucun mouvement de ce montant dans Kora</span>}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>{write && (l.status === 'matched'
                ? <button className="btn sm" disabled={busy} onClick={() => act(() => api(`/company/treasury/reconciliation/lines/${l.id}/unmatch`, { body: {} }))}>Dépointer</button>
                : l.status === 'ignored'
                  ? <button className="btn sm" disabled={busy} onClick={() => act(() => api(`/company/treasury/reconciliation/lines/${l.id}/ignore`, { body: { ignored: false } }))}>Reprendre</button>
                  : <>
                    <button className="btn sm" disabled={busy} onClick={() => setRecord({ line: l, category: l.amount < 0 ? 'bank_fees' : 'other_income', label: l.label })}>{l.amount < 0 ? 'Enregistrer la dépense' : 'Enregistrer la recette'}</button>
                    <button className="btn sm" disabled={busy} onClick={() => act(() => api(`/company/treasury/reconciliation/lines/${l.id}/ignore`, { body: { ignored: true } }))}>Écarter</button>
                    <button className="btn sm danger" disabled={busy} title="Supprimer cette ligne importée" onClick={() => act(() => api(`/company/treasury/reconciliation/lines/${l.id}`, { method: 'DELETE' }))}>✕</button>
                  </>)}</div></td>
            </tr>
          )) : <tr><td colSpan={5} className="muted">{filter === 'pending' ? (data.lines.length ? 'Tout est pointé.' : 'Importez un relevé pour commencer.') : 'Aucune ligne.'}</td></tr>}</tbody>
        </table></div>
        {data.movements.length > 0 && <>
          <h2 style={{ margin: 0 }}>Mouvements de Kora absents du relevé</h2>
          <p className="small muted" style={{ margin: 0 }}>Chèques pas encore encaissés, virements en cours… ou erreurs de saisie à corriger dans le journal du compte.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Libellé</th><th>Référence</th><th className="n">Montant</th></tr></thead>
            <tbody>{data.movements.map((m: any) => <tr key={m.id}><td>{date(m.date)}</td><td>{m.label}</td><td className="small">{m.reference ?? ''}</td><td className="n" style={{ whiteSpace: 'nowrap' }}>{money(m.amount)}</td></tr>)}</tbody>
          </table></div>
        </>}
      </>}
      {record && (
        <div className="modal-back" onClick={() => setRecord(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); act(async () => { await api(`/company/treasury/reconciliation/lines/${record.line.id}/record`, { body: { category: record.category, label: record.label } }); setRecord(null); }, 'Opération enregistrée dans Kora et pointée.'); }} style={{ display: 'grid', gap: 12 }}>
            <h2>{record.line.amount < 0 ? 'Enregistrer la dépense' : 'Enregistrer la recette'} — {money(Math.abs(record.line.amount))}</h2>
            <p className="small muted" style={{ margin: 0 }}>Le {date(record.line.date)}, sur {account?.name}. Le mouvement est comptabilisé comme une saisie de trésorerie normale.</p>
            <label className="field">Catégorie<select className="input" value={record.category} onChange={(e) => setRecord({ ...record, category: e.target.value })}>
              {Object.entries(record.line.amount < 0 ? EXPENSE_CATEGORIES : INCOME_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field">Libellé<input className="input" required minLength={2} maxLength={200} value={record.label} onChange={(e) => setRecord({ ...record, label: e.target.value })} /></label>
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setRecord(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
