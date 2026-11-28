'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

/** Modules d'une entreprise (selon sa formule, retirés ou ajoutés à la main) et nouveautés activées à la demande du client. */
export default function CompanyFeatures() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [mods, setMods] = useState<any>(null);
  const [modConfirm, setModConfirm] = useState<{ m: any; enabled: boolean | null } | null>(null);
  const [shop, setShop] = useState({ registers: 1, purchases: true, accounting: false });
  const [shopAsk, setShopAsk] = useState(false);
  const [shopResult, setShopResult] = useState<any>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const [f, m] = await Promise.all([api(`/platform/companies/${id}/features`), api(`/platform/companies/${id}/modules`)]);
    setData(f); setMods(m);
  }, [id]);
  const label = (k: string) => mods?.modules.find((m: any) => m.key === k)?.label ?? k;
  const applyModule = () => run(async () => {
    const { m, enabled } = modConfirm!;
    await api(`/platform/companies/${id}/modules/${m.key}`, { method: 'PUT', body: { enabled } });
    setModConfirm(null);
    setNotice(`Module « ${m.label} » ${enabled === null ? 'rendu à la formule' : enabled ? 'activé' : 'retiré'} pour ${mods.company.name}.`); await load();
  });
  const applyShop = () => run(async () => {
    const r = await api(`/platform/companies/${id}/profiles/boutique`, { body: shop });
    setShopAsk(false); setNotice(''); setShopResult(r); await load();
  });
  const RESULT: Record<string, string> = { removed: 'retiré', enabled: 'réactivé', unchanged: 'inchangé', not_in_plan: 'non inclus dans la formule' };
  /** Origine de l'état affiché : formule, ou choix fait dans la console. */
  const source = (m: any) => m.choice === null ? (m.inPlan ? 'Inclus dans la formule' : 'Hors formule') : m.choice ? (m.inPlan ? 'Activé à la main' : 'Ajouté hors formule') : 'Retiré à la main';
  useEffect(() => { run(load); }, [load]); // eslint-disable-line
  const apply = (f: any) => run(async () => {
    await api(`/platform/companies/${id}/features/${f.key}`, { method: 'PUT', body: { enabled: !f.enabled } });
    setConfirm(null); setNotice(`« ${f.label} » ${f.enabled ? 'désactivée' : 'activée'} pour ${data.company.name}.`); await load();
  });
  return (
    <>
      <div className="page-head"><h1>Modules et fonctionnalités{data && <> · {data.company.name}</>}</h1><Link className="btn sm" href="/console/fonctionnalites">Toutes les entreprises</Link></div>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      {mods && <section className="card" style={{ display: 'grid', gap: 10 }}>
        <header><h2>Profil Boutique</h2><span className="small muted">1 à 3 caisses</span></header>
        <p className="small" style={{ margin: 0 }}>Garde ce dont une boutique se sert chaque jour (point de vente, stocks, rapports et point journalier) et retire Employés, Congés, Évaluations, Paie et Calendrier.
          Pour une entreprise <b>en préparation</b>, crée aussi une caisse de vente par poste (« Caisse 1 »…), chacune avec son compte de caisse. Le profil peut être rejoué : ce qui existe déjà est gardé.</p>
        <div className="row" style={{ alignItems: 'end', gap: 16 }}>
          <label className="field" style={{ width: 160 }}>Nombre de caisses<select className="input" value={shop.registers} onChange={(e) => setShop({ ...shop, registers: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={shop.purchases} onChange={(e) => setShop({ ...shop, purchases: e.target.checked })} />Garder les Achats (fournisseurs avec factures)</label>
          <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={shop.accounting} onChange={(e) => setShop({ ...shop, accounting: e.target.checked })} />Garder la Comptabilité (un comptable s&apos;en sert)</label>
        </div>
        {shopAsk ? <div className="row" style={{ alignItems: 'center' }}>
          <span className="small"><b>Appliquer le profil Boutique à {mods.company.name} ?</b> Les modules retirés disparaîtront des menus de ses utilisateurs (données conservées).</span>
          <button className="btn sm primary" disabled={busy} onClick={applyShop}>Confirmer</button>
          <button className="btn sm" disabled={busy} onClick={() => setShopAsk(false)}>Annuler</button>
        </div> : <div><button className="btn primary" disabled={busy} onClick={() => { setShopResult(null); setShopAsk(true); }}>Appliquer le profil Boutique</button></div>}
        {shopResult && <Alert kind="ok"><div style={{ display: 'grid', gap: 6 }}>
          <div><b>Profil appliqué.</b> {shopResult.modules.filter((m: any) => m.result !== 'unchanged').map((m: any) => `${m.label} : ${RESULT[m.result]}`).join(' · ') || 'Les modules étaient déjà réglés.'}</div>
          {shopResult.registers
            ? <div>Caisses : {shopResult.registers.created.length ? <>créées {shopResult.registers.created.join(', ')}</> : 'aucune à créer'}{shopResult.registers.existing.length > 0 && <> · déjà présentes {shopResult.registers.existing.join(', ')}</>}.</div>
            : <div>Entreprise en service : ses caisses restent à la main du client. À lui faire faire : <b>Point de vente → Caisses</b>, une caisse par poste, chacune sur son compte de caisse (<b>Trésorerie</b> → nouveau compte « Caisse 2 »…), puis inviter chaque caissier avec le rôle <b>Caissier</b>.</div>}
          <div className="small">Rôles déjà prêts dans l&apos;entreprise : Caissier (encaisse, ne voit ni marges ni achats), Directeur / gérant (contrôle et clôture les caisses), Magasinier (réceptions, inventaires).</div>
        </div></Alert>}
      </section>}
      {mods && <section className="card" style={{ display: 'grid', gap: 10 }}>
        <header><h2>Modules</h2>{mods.plan && <span className="small muted">Formule {mods.plan}</span>}</header>
        <p className="small muted" style={{ margin: 0 }}>Un module retiré disparaît des menus de tous les utilisateurs et son accès est refusé ; ses données sont conservées et reviennent dès qu&apos;on le réactive. Un module peut aussi être ajouté hors formule.</p>
        <div className="small">Socle, toujours actif : {mods.core.map((c: any) => <Pill key={c.key} tone="ok">{c.label}</Pill>)}</div>
        <div className="table-wrap"><table>
          <thead><tr><th>Module</th><th>État</th><th>Origine</th><th /></tr></thead>
          <tbody>{mods.modules.map((m: any) => (
            <tr key={m.key}>
              <td><b>{m.label}</b><div className="small muted">{m.description}{m.requires.length > 0 && <> Nécessite : {m.requires.map(label).join(', ')}.</>}</div></td>
              <td>{m.enabled ? <Pill tone="ok">Actif</Pill> : <Pill>Inactif</Pill>}</td>
              <td className="small">{source(m)}{m.changedAt && <div className="muted">le {date(m.changedAt)}{m.changedBy && <> par {m.changedBy}</>}</div>}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>
                {modConfirm?.m.key === m.key ? <>
                  <button className={`btn sm ${modConfirm?.enabled === false ? 'danger' : 'primary'}`} disabled={busy} onClick={applyModule}>Confirmer</button>{' '}
                  <button className="btn sm" disabled={busy} onClick={() => setModConfirm(null)}>Annuler</button>
                </> : <>
                  {m.choice !== null && <><button className="btn sm" disabled={busy} title="Revenir à ce que prévoit la formule" onClick={() => { setNotice(''); setModConfirm({ m, enabled: null }); }}>Selon la formule</button>{' '}</>}
                  {m.enabled
                    ? <button className="btn sm" disabled={busy} onClick={() => { setNotice(''); setModConfirm({ m, enabled: false }); }}>Retirer</button>
                    : <button className="btn sm primary" disabled={busy} onClick={() => { setNotice(''); setModConfirm({ m, enabled: true }); }}>{m.inPlan ? 'Réactiver' : 'Ajouter'}</button>}
                </>}
              </td>
            </tr>))}</tbody>
        </table></div>
      </section>}
      <h2 style={{ margin: '8px 0 0' }}>Nouveautés</h2>
      <p className="muted" style={{ margin: 0 }}>Les nouveautés de Kora sont désactivées pour toutes les entreprises. Activez-les ici, une par une, quand le client le demande : ses utilisateurs voient la fonction dès leur prochaine page. Une fonctionnalité déjà utilisée ne peut plus être retirée.</p>
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
