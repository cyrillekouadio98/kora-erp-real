'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { ImportButton } from '@/components/import';
import { ODOO_BALANCE, ODOO_CONTACTS, ODOO_OPEN_INVOICES, ODOO_PRODUCTS, SUSPENSE } from '@/components/odoo-import';
import { Alert, useAction } from '@/components/ui';

/**
 * Reprise depuis Odoo : quatre imports dans l'ordre (tiers, articles et stock, factures non soldées, soldes des comptes),
 * puis la trésorerie saisie à la main. Tout passe par le compte d'attente 471000 : son solde nul confirme la reprise.
 */
export default function OdooImportPage() {
  const { has, can, ctx } = useSession();
  const [state, setState] = useState<any>(null);
  const { error, run } = useAction();
  const load = useCallback(() => run(async () => {
    const [contacts, products, suspense, drafts] = await Promise.all([
      api<any[]>('/company/contacts?archived=all'), api<any[]>('/company/products?archived=all'),
      api<any>('/company/accounting/suspense').catch(() => null), api<any>(`/company/accounting/entries?journal=AN&q=${encodeURIComponent('Reprise Odoo')}`).catch(() => null),
    ]);
    const list: any[] = (Array.isArray(drafts) ? drafts : drafts?.items ?? []).filter((e: any) => String(e.label).startsWith('Reprise Odoo'));
    setState({ contacts: contacts.length, products: products.length, suspense, drafts: list.filter((e) => e.status === 'draft').length, posted: list.filter((e) => e.status === 'posted').length });
  }), []); // eslint-disable-line
  useEffect(() => { if (has('odoo_import')) load(); }, []); // eslint-disable-line
  if (!has('odoo_import')) return <Alert kind="warn">La reprise depuis Odoo n&apos;est pas activée pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;
  const writable = !ctx?.readOnly;
  const step = (n: number, title: string, body: React.ReactNode, action: React.ReactNode, done?: React.ReactNode) => (
    <section className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>{n}. {title}</h2>{done && <span className="small muted">{done}</span>}
      </div>
      <div className="small">{body}</div>
      {writable && <div className="row">{action}</div>}
    </section>
  );
  const balance = state?.suspense?.balance ?? 0;
  return (
    <>
      <div className="page-head"><h1>Reprise depuis Odoo</h1></div>
      <p className="muted" style={{ margin: 0 }}>Exportez vos données depuis Odoo en Excel (Action → Exporter dans chaque liste), puis importez-les ici <b>dans l&apos;ordre</b>. Chaque import montre un aperçu ligne à ligne avant d&apos;enregistrer, ignore ce qui existe déjà et peut donc être relancé. Les montants repris passent par le compte d&apos;attente {SUSPENSE} : quand tout est repris et validé, son solde revient à zéro.</p>
      <Alert>{error}</Alert>

      {step(1, 'Clients et fournisseurs', <>Les partenaires d&apos;Odoo deviennent des contacts de Kora (client, fournisseur ou les deux d&apos;après leurs rangs Odoo).</>,
        can('contacts.create') && <ImportButton config={ODOO_CONTACTS} label="Importer les contacts" onDone={load} />,
        state && `${state.contacts} contact(s) dans Kora`)}

      {step(2, 'Articles et stock', <>Les produits d&apos;Odoo deviennent des articles ; leur quantité en stock est enregistrée comme stock initial au coût Odoo.</>,
        can('products.create') && <ImportButton config={ODOO_PRODUCTS} label="Importer les articles" onDone={load} />,
        state && `${state.products} article(s) dans Kora`)}

      {step(3, 'Factures non soldées', <>Les factures clients et fournisseurs encore dues forment les soldes d&apos;ouverture de chaque tiers (comptes 411000 et 401000). Importez un fichier pour les clients, un autre pour les fournisseurs.</>,
        can('accounting.create') && <ImportButton config={ODOO_OPEN_INVOICES} label="Importer les factures" onDone={load} />)}

      {step(4, 'Soldes des autres comptes', <>Capital, immobilisations, emprunts, dettes fiscales et sociales… : une écriture d&apos;à-nouveaux reprend les soldes du plan comptable d&apos;Odoo, hors stock, clients, fournisseurs et trésorerie.</>,
        can('accounting.create') && <ImportButton config={ODOO_BALANCE} label="Importer les soldes" onDone={load} />)}

      {step(5, 'Caisses et banques', <>Dans <Link href="/app/tresorerie">Trésorerie</Link>, créez chaque caisse, compte bancaire et compte mobile money avec son <b>solde d&apos;ouverture</b> à la date de reprise et la contrepartie <b>{SUSPENSE}</b> (compte d&apos;attente).</>, null)}

      <section className="card" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Contrôle de la reprise</h2>
        {state && state.drafts > 0 && <Alert kind="warn">{state.drafts} écriture(s) d&apos;à-nouveaux en brouillon : validez-les dans <Link href="/app/comptabilite">Comptabilité</Link> pour qu&apos;elles comptent dans le contrôle.</Alert>}
        {state && !state.posted && balance === 0 && <p className="small muted" style={{ margin: 0 }}>Aucune écriture de reprise validée pour l&apos;instant.</p>}
        {state && (state.posted > 0 || balance !== 0) && (balance === 0
          ? <Alert kind="ok">Le compte d&apos;attente {SUSPENSE} est soldé : le stock, les tiers, les soldes et la trésorerie repris s&apos;équilibrent.</Alert>
          : <Alert kind="warn">Solde du compte d&apos;attente {SUSPENSE} : <b>{money(Math.abs(balance))}</b> {balance > 0 ? 'au débit' : 'au crédit'}. Tant que toutes les étapes ne sont pas faites et validées, c&apos;est normal ; ensuite, l&apos;écart montre une différence entre Odoo et ce qui a été repris (stock valorisé autrement qu&apos;en comptabilité, facture oubliée…). Un écart justifié se reclasse depuis Comptabilité → Clôture d&apos;exercice.</Alert>)}
      </section>
    </>
  );
}
