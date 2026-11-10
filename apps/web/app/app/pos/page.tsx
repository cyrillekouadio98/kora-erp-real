'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const hour = (v: string) => new Date(v).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Point de vente : les caisses, leur session en cours, ouverture et paramétrage. */
export default function PosHome() {
  const { can, ctx, me } = useSession();
  const router = useRouter();
  const writable = !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [opening, setOpening] = useState<any>(null);
  const [refs, setRefs] = useState<{ warehouses: any[]; accounts: any[] }>({ warehouses: [], accounts: [] });
  const { busy, error, run } = useAction();

  const load = useCallback(() => run(async () => setRows(await api(`/company/pos/registers${archived ? '?archived=true' : ''}`))), [archived]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!edit) return;
    Promise.all([api<any[]>('/company/stock/warehouses').catch(() => []), api<any[]>('/company/treasury/accounts').catch(() => [])])
      .then(([w, a]) => setRefs({ warehouses: w.filter((x) => !x.archived), accounts: a.filter((x) => x.kind === 'cash' && !x.archivedAt) }));
  }, [!!edit]); // eslint-disable-line

  const sites = ctx?.sites ?? [];
  const siteId = edit?.siteId || ctx?.siteId || sites[0]?.id || '';
  const save = () => run(async () => {
    const body: any = { name: edit.name, warehouseId: edit.warehouseId || null, cashAccountId: edit.cashAccountId || null };
    if (edit.id) await api(`/company/pos/registers/${edit.id}`, { method: 'PATCH', body: { name: body.name, ...(body.warehouseId ? { warehouseId: body.warehouseId } : {}), ...(body.cashAccountId ? { cashAccountId: body.cashAccountId } : {}) } });
    else await api('/company/pos/registers', { body: { ...body, siteId: siteId || null } });
    setEdit(null); await load();
  });
  const archive = (r: any, value: boolean) => run(async () => { await api(`/company/pos/registers/${r.id}`, { method: 'PATCH', body: { archived: value } }); await load(); });
  const open = () => run(async () => {
    await api(`/company/pos/registers/${opening.id}/open`, { body: { openingFloat: Number(opening.float) || 0 } });
    router.push(`/app/pos/caisse/${opening.id}`);
  });

  return (
    <>
      <div className="page-head">
        <h1>Point de vente</h1>
        <div className="row">
          <label className="row small"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Caisses archivées</label>
          {can('pos.admin') && writable && <button className="btn primary" onClick={() => setEdit({ name: `Caisse ${(rows?.length ?? 0) + 1}`, warehouseId: '', cashAccountId: '' })}>Nouvelle caisse</button>}
        </div>
      </div>
      <Alert>{!edit && !opening && error}</Alert>

      {rows && !rows.length && <div className="card muted" style={{ textAlign: 'center', padding: 32 }}>
        {archived ? 'Aucune caisse archivée.' : <>Aucune caisse pour l’instant.{can('pos.admin') ? ' Créez une caisse pour chaque poste d’encaissement (comptoir, caisse 1, caisse 2…) : elle vend la marchandise d’un entrepôt et encaisse les espèces sur un compte de caisse.' : ' Demandez à un administrateur de créer une caisse.'}</>}
      </div>}

      <div className="pos-registers">
        {rows?.map((r) => {
          const s = r.session;
          const mine = s && s.openedById === me.user.id;
          return (
            <section key={r.id} className="card pos-register" style={r.archivedAt ? { opacity: .6 } : undefined}>
              <header className="row" style={{ justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0 }}>{r.name}</h2>
                {r.archivedAt ? <Pill>Archivée</Pill> : s ? <Pill tone="ok">Ouverte</Pill> : <Pill>Fermée</Pill>}
              </header>
              <dl className="stock-meta small">
                {sites.length > 1 && <><dt>Site</dt><dd>{r.siteName}</dd></>}
                <dt>Entrepôt</dt><dd>{r.warehouseName}</dd>
                <dt>Espèces sur</dt><dd>{r.cashAccountName}</dd>
                {s && <><dt>Session</dt><dd>{s.number} · {s.openedBy}, {hour(s.openedAt)}</dd>
                  <dt>Ventes</dt><dd><b>{money(s.total)}</b> · {s.tickets} ticket{s.tickets > 1 ? 's' : ''}</dd></>}
              </dl>
              {!r.archivedAt && <div className="row">
                {s ? (mine || can('pos.validate')) && can('pos.create') && <Link className="btn primary" href={`/app/pos/caisse/${r.id}`}>{mine ? 'Reprendre la vente' : 'Voir la caisse'}</Link>
                  : can('pos.create') && writable && <button className="btn primary" onClick={() => setOpening({ ...r, float: '' })}>Ouvrir la caisse</button>}
                {s && can('pos.read') && <Link className="btn" href={`/app/pos/sessions?id=${s.id}`}>Rapport X</Link>}
                {can('pos.admin') && writable && <button className="btn" onClick={() => setEdit({ id: r.id, name: r.name, siteId: r.siteId, warehouseId: r.warehouseId, cashAccountId: r.cashAccountId })}>Paramétrer</button>}
                {can('pos.admin') && writable && !s && <button className="btn danger" disabled={busy} onClick={() => archive(r, true)}>Archiver</button>}
              </div>}
              {r.archivedAt && can('pos.admin') && writable && <div><button className="btn" disabled={busy} onClick={() => archive(r, false)}>Restaurer</button></div>}
            </section>
          );
        })}
      </div>

      {opening && (
        <div className="modal-back" onClick={() => setOpening(null)}>
          <form className="modal" style={{ width: 'min(440px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); open(); }}>
            <h2>Ouvrir {opening.name}</h2>
            <Alert>{error}</Alert>
            <Field label="Fond de caisse (espèces dans le tiroir, FCFA)" type="number" min={0} step="any" autoFocus value={opening.float} onChange={(e) => setOpening({ ...opening, float: e.target.value })} placeholder="0" />
            <p className="small muted" style={{ margin: 0 }}>Comptez la monnaie mise dans le tiroir avant la première vente. À la clôture, vous compterez à nouveau : l’écart avec les espèces attendues sera inscrit en trésorerie.</p>
            <div className="row"><button className="btn primary" disabled={busy}>Ouvrir et vendre</button><button type="button" className="btn" onClick={() => setOpening(null)}>Annuler</button></div>
          </form>
        </div>
      )}

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" style={{ width: 'min(560px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `Paramétrer ${edit.name}` : 'Nouvelle caisse'}</h2>
            <Alert>{error}</Alert>
            <Field label="Nom" required minLength={2} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Caisse 1, Comptoir, Pharmacie…" />
            {!edit.id && sites.length > 1 && <label className="field">Site
              <select className="input" value={siteId} onChange={(e) => setEdit({ ...edit, siteId: e.target.value, warehouseId: '', cashAccountId: '' })}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
            <label className="field">Entrepôt (la marchandise vendue en sort)
              <select className="input" value={edit.warehouseId} onChange={(e) => setEdit({ ...edit, warehouseId: e.target.value })}>
                {!edit.id && <option value="">Entrepôt principal du site</option>}
                {refs.warehouses.filter((w) => !siteId || w.siteId === siteId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select></label>
            <label className="field">Compte de caisse (les espèces y sont encaissées)
              <select className="input" value={edit.cashAccountId} onChange={(e) => setEdit({ ...edit, cashAccountId: e.target.value })}>
                {!edit.id && <option value="">Caisse principale du site</option>}
                {refs.accounts.filter((a) => !siteId || a.siteId === siteId || sites.length <= 1).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select></label>
            <p className="small muted" style={{ margin: 0 }}>Mobile money et carte sont encaissés sur les comptes de ce type dans Trésorerie. Les ventes sans client choisi sont au nom de « Client comptoir ».</p>
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
