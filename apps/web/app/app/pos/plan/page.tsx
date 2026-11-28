'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Field, useAction } from '@/components/ui';
import { STATIONS } from '@/components/pos';

const SHAPES: Record<string, string> = { square: 'Carrée', round: 'Ronde', long: 'Longue (2 cases)' };
const COLS = 12;

/** Plan de salle : salles d'un site et tables placées sur une grille (glisser-déposer pour les déplacer). */
export default function FloorPlanPage() {
  const { has, can, ctx } = useSession();
  const sites = ctx?.sites ?? [];
  const [siteId, setSiteId] = useState('');
  const [floor, setFloor] = useState<any>(null);
  const [areaId, setAreaId] = useState('');
  const [newArea, setNewArea] = useState<string | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const [over, setOver] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [products, setProducts] = useState<any[] | null>(null);
  const [pq, setPq] = useState('');
  const { busy, error, run, setError } = useAction();
  const admin = can('pos.admin') && !ctx?.readOnly;

  const load = useCallback(async () => {
    const f = await api<any>(`/company/restaurant/floor${siteId ? `?siteId=${siteId}` : ''}`);
    setFloor(f);
    if (!siteId) setSiteId(f.siteId);
    setAreaId((a) => (f.areas.some((x: any) => x.id === a) ? a : f.areas[0]?.id ?? ''));
  }, [siteId]);
  useEffect(() => { if (has('restaurant_tables')) run(load); }, [load]); // eslint-disable-line
  useEffect(() => { if (has('restaurant_tables') && can('pos.admin')) api<any[]>('/company/restaurant/stations').then(setProducts, () => {}); }, []); // eslint-disable-line

  if (!has('restaurant_tables')) return <Alert kind="warn">Le plan de salle n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;
  if (!can('pos.admin')) return <Alert kind="warn">Le plan de salle se modifie avec le droit d&apos;administrer les caisses.</Alert>;

  const area = floor?.areas.find((a: any) => a.id === areaId);
  const tables = area?.tables ?? [];
  const rows = Math.max(6, ...tables.map((x: any) => x.y + 2));
  const width = (x: any) => (x.shape === 'long' ? 2 : 1);
  /** Case occupée par une autre table (une table longue prend deux cases). */
  const taken = (cx: number, cy: number, except?: string) => tables.some((x: any) => x.id !== except && x.y === cy && cx >= x.x && cx < x.x + width(x));
  const freeCell = (w = 1) => { for (let y = 0; y < 30; y++) for (let x = 0; x <= COLS - w; x++) if (![...Array(w)].some((_, i) => taken(x + i, y))) return { x, y }; return { x: 0, y: rows }; };
  const nextName = () => { const nums = floor.areas.flatMap((a: any) => a.tables).map((x: any) => Number(String(x.name).replace(/\D/g, ''))).filter((v: number) => v > 0); return `T${(nums.length ? Math.max(...nums) : 0) + 1}`; };

  const addArea = () => run(async () => {
    const r = await api<any>('/company/restaurant/areas', { body: { name: newArea, siteId } });
    setNewArea(null); setAreaId(r.id); await load();
  });
  const renameArea = () => run(async () => { await api(`/company/restaurant/areas/${areaId}`, { method: 'PATCH', body: { name: rename } }); setRename(null); await load(); });
  const archiveArea = () => run(async () => {
    if (!window.confirm(`Retirer la salle « ${area.name} » et ses ${tables.length} table(s) du plan ?`)) return;
    await api(`/company/restaurant/areas/${areaId}`, { method: 'PATCH', body: { archived: true } }); setNotice(`Salle « ${area.name} » retirée.`); await load();
  });
  const saveTable = () => run(async () => {
    const body: any = { name: edit.name, seats: Number(edit.seats) || 1, shape: edit.shape };
    if (edit.id) {
      if (edit.areaId !== areaId) body.areaId = edit.areaId;
      await api(`/company/restaurant/tables/${edit.id}`, { method: 'PATCH', body });
    } else await api('/company/restaurant/tables', { body: { ...body, areaId, ...freeCell(edit.shape === 'long' ? 2 : 1) } });
    setEdit(null); await load();
  });
  const archiveTable = () => run(async () => { await api(`/company/restaurant/tables/${edit.id}`, { method: 'PATCH', body: { archived: true } }); setNotice(`Table ${edit.name} retirée du plan.`); setEdit(null); await load(); });
  const setStation = (ids: string[], station: string) => run(async () => {
    await api('/company/restaurant/stations', { method: 'PUT', body: { productIds: ids, station } });
    setProducts((ps) => ps!.map((p) => (ids.includes(p.id) ? { ...p, station } : p)));
  });
  const drop = (id: string, cx: number, cy: number) => {
    setOver(null);
    const x = tables.find((t: any) => t.id === id);
    if (!x || (x.x === cx && x.y === cy)) return;
    if (cx + width(x) > COLS || [...Array(width(x))].some((_, i) => taken(cx + i, cy, id))) { setError('Cette place est déjà prise par une autre table.'); return; }
    // Déplacement affiché tout de suite, enregistré ensuite.
    setFloor({ ...floor, areas: floor.areas.map((a: any) => a.id !== areaId ? a : { ...a, tables: a.tables.map((t: any) => t.id === id ? { ...t, x: cx, y: cy } : t) }) });
    run(async () => { await api(`/company/restaurant/tables/${id}`, { method: 'PATCH', body: { x: cx, y: cy } }); });
  };

  return (
    <>
      <div className="page-head"><h1>Plan de salle</h1>
        <div className="row">
          {sites.length > 1 && <select className="input" style={{ width: 200 }} value={siteId} onChange={(e) => { setAreaId(''); setSiteId(e.target.value); }} aria-label="Site">
            {sites.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          <Link className="btn sm" href="/app/pos/salle">Voir la salle</Link>
        </div></div>
      <p className="muted" style={{ margin: 0 }}>Créez une salle par espace (salle, terrasse, étage), ajoutez ses tables puis faites-les glisser à leur place. Touchez une table pour la renommer, changer son nombre de places ou la retirer.</p>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      {floor && <>
        <div className="floor-tabs" style={{ alignItems: 'center' }}>
          {floor.areas.map((a: any) => <button key={a.id} className={`btn sm${a.id === areaId ? ' primary' : ''}`} onClick={() => { setNotice(''); setAreaId(a.id); }}>{a.name} <span className="muted">({a.tables.length})</span></button>)}
          {admin && (newArea === null
            ? <button className="btn sm" onClick={() => setNewArea(floor.areas.length ? '' : 'Salle')}>+ Nouvelle salle</button>
            : <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); addArea(); }}>
                <input className="input" style={{ width: 180 }} autoFocus required maxLength={40} placeholder="Terrasse, Étage…" value={newArea} onChange={(e) => setNewArea(e.target.value)} aria-label="Nom de la salle" />
                <button className="btn sm primary" disabled={busy}>Créer</button><button type="button" className="btn sm" onClick={() => setNewArea(null)}>Annuler</button></form>)}
        </div>
        {!floor.areas.length && <p className="muted">Commencez par créer une salle.</p>}
        {area && <>
          <div className="row" style={{ alignItems: 'center' }}>
            {rename === null ? <>
              {admin && <button className="btn sm primary" onClick={() => { setError(''); setEdit({ name: nextName(), seats: '4', shape: 'square', areaId }); }}>+ Ajouter une table</button>}
              {admin && <button className="btn sm" onClick={() => setRename(area.name)}>Renommer la salle</button>}
              {admin && <button className="btn sm danger" disabled={busy} onClick={archiveArea}>Retirer la salle</button>}
            </> : <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); renameArea(); }}>
              <input className="input" style={{ width: 200 }} autoFocus required maxLength={40} value={rename} onChange={(e) => setRename(e.target.value)} aria-label="Nouveau nom de la salle" />
              <button className="btn sm primary" disabled={busy}>Enregistrer</button><button type="button" className="btn sm" onClick={() => setRename(null)}>Annuler</button></form>}
          </div>
          <div className="floor-grid editing" style={{ ['--cols' as any]: COLS, gridTemplateRows: `repeat(${rows}, 100px)` }}>
            {[...Array(rows)].flatMap((_, cy) => [...Array(COLS)].map((__, cx) => (
              <div key={`${cx}-${cy}`} className={`floor-cell${over === `${cx}-${cy}` ? ' over' : ''}`} style={{ gridColumn: cx + 1, gridRow: cy + 1 }}
                onDragOver={(e) => { e.preventDefault(); setOver(`${cx}-${cy}`); }} onDragLeave={() => setOver((o) => (o === `${cx}-${cy}` ? null : o))}
                onDrop={(e) => { e.preventDefault(); drop(e.dataTransfer.getData('text/plain'), cx, cy); }} />
            )))}
            {tables.map((x: any) => (
              <button key={x.id} type="button" draggable={admin} className={`floor-table${x.shape === 'round' ? ' round' : ''}${x.order ? ' busy' : ''}`}
                style={{ gridColumn: `${x.x + 1} / span ${width(x)}`, gridRow: x.y + 1, zIndex: 1 }}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', x.id); e.dataTransfer.effectAllowed = 'move'; }}
                aria-label={`Table ${x.name}, ${x.seats} places : modifier ou faire glisser`}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}
                onClick={() => { setError(''); setNotice(''); setEdit({ id: x.id, name: x.name, seats: String(x.seats), shape: x.shape, areaId, busy: !!x.order }); }}>
                <b>{x.name}</b><span className="small muted">{x.seats} places</span>
              </button>
            ))}
          </div>
        </>}
      </>}

      {products && <section className="card" style={{ display: 'grid', gap: 10 }}>
        <header><h2>Postes de préparation</h2><span className="small muted">{products.filter((p) => p.station === 'kitchen').length} en cuisine · {products.filter((p) => p.station === 'bar').length} au bar</span></header>
        <p className="small muted" style={{ margin: 0 }}>Quand le serveur envoie la commande, chaque article part sur l&apos;écran de son poste : <b>Cuisine</b> (plats), <b>Bar</b> (cocktails, boissons à préparer) ; <b>Sans préparation</b> pour ce qui est servi tel quel (canette, eau).</p>
        <input className="input" style={{ maxWidth: 320 }} type="search" placeholder="Rechercher un article" value={pq} onChange={(e) => setPq(e.target.value)} aria-label="Rechercher un article" />
        <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}><table>
          <thead><tr><th>Article</th><th>Poste</th></tr></thead>
          <tbody>{products.filter((p) => !pq.trim() || `${p.code} ${p.name}`.toLowerCase().includes(pq.trim().toLowerCase())).slice(0, 300).map((p) => (
            <tr key={p.id}><td>{p.name} <span className="small muted">{p.code}</span></td>
              <td><select className="input" style={{ width: 200 }} disabled={!admin || busy} value={p.station} onChange={(e) => setStation([p.id], e.target.value)} aria-label={`Poste de ${p.name}`}>
                {Object.entries(STATIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td></tr>))}</tbody>
        </table></div>
      </section>}

      {edit && <div className="modal-back" onClick={() => setEdit(null)}><form className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); saveTable(); }}>
        <h2 style={{ margin: 0 }}>{edit.id ? `Table ${edit.name}` : 'Nouvelle table'}</h2>
        <Alert>{error}</Alert>
        <div className="grid2">
          <Field label="Nom" required maxLength={40} autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <Field label="Places" type="number" min={1} max={50} required value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: e.target.value })} />
          <label className="field">Forme<select className="input" value={edit.shape} onChange={(e) => setEdit({ ...edit, shape: e.target.value })}>{Object.entries(SHAPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {edit.id && floor.areas.length > 1 && <label className="field">Salle<select className="input" value={edit.areaId} onChange={(e) => setEdit({ ...edit, areaId: e.target.value })}>{floor.areas.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row"><button className="btn primary" disabled={busy}>{edit.id ? 'Enregistrer' : 'Ajouter'}</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          {edit.id && <button type="button" className="btn danger" disabled={busy || edit.busy} title={edit.busy ? 'Table occupée' : undefined} onClick={archiveTable}>Retirer du plan</button>}
        </div>
      </form></div>}
    </>
  );
}
