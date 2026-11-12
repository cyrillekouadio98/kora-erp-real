'use client';
import { money } from '@/lib/format';

/** Modes de paiement acceptés à la caisse. */
export const POS_METHODS: Record<string, string> = { cash: 'Espèces', mobile_money: 'Mobile money', card: 'Carte bancaire' };

const time = (v?: string | null) => (v ? new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const qty = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
export const ttc = (ht: number, rate: number) => Math.round(ht * (1 + rate / 100));

/** Ligne de panier : arrondis identiques à ceux de l'API (HT arrondi par ligne, puis TVA). */
export function lineTotals(l: { quantity: number; unitPrice: number; vatRate: number; discountPct?: number }) {
  const ht = Math.round(l.quantity * l.unitPrice * (1 - (l.discountPct ?? 0) / 100));
  const vat = Math.round((ht * l.vatRate) / 100);
  return { ht, vat, ttc: ht + vat };
}

function Head({ company, title, sub }: { company: any; title: string; sub: React.ReactNode }) {
  return (
    <div className="tk-head">
      {company.logo && <img src={company.logo} alt="" />}
      <b className="tk-name">{company.name}</b>
      {sub}
      {(company.taxId || company.rccm) && <span>{company.taxId ? `NCC ${company.taxId}` : ''}{company.taxId && company.rccm ? ' · ' : ''}{company.rccm ? `RCCM ${company.rccm}` : ''}</span>}
      <b className="tk-title">{title}</b>
    </div>
  );
}

/** Ticket de caisse (80 mm à l'impression). */
export function PosTicket({ t }: { t: any }) {
  return (
    <div className="tk print-area">
      <Head company={t.company} title={`Ticket ${t.number}`} sub={<>
        <span>{t.siteName}{t.siteAddress ? ` — ${t.siteAddress}` : ''}</span>
        {t.sitePhone && <span>Tél. {t.sitePhone}</span>}
      </>} />
      <div className="tk-meta"><span>{time(t.at)}</span><span>{t.registerName}</span></div>
      <div className="tk-meta"><span>Caissier : {t.cashier ?? '—'}</span><span>{t.sessionNumber}</span></div>
      {!t.walkIn && <div className="tk-meta"><span>Client : {t.customer?.name}</span></div>}
      <div className="tk-lines">
        {t.lines.map((l: any, i: number) => (
          <div key={i} className="tk-line">
            <div>{l.description}</div>
            <div className="tk-row"><span>{qty(l.quantity)} × {money(ttc(l.unitPrice, l.vatRate))}{l.discountPct ? ` −${l.discountPct} %` : ''}</span><b>{money(l.totalHt + l.totalVat)}</b></div>
          </div>
        ))}
      </div>
      <div className="tk-total"><span>TOTAL TTC</span><b>{money(t.totalTtc)}</b></div>
      <div className="tk-sub">
        {t.payments.map((p: any, i: number) => <div key={i} className="tk-row"><span>{POS_METHODS[p.method] ?? p.method}{p.method === 'cash' && t.cashTendered ? ' reçues' : ''}{p.reference ? ` (${p.reference})` : ''}</span>
          <span>{money(p.method === 'cash' && t.cashTendered ? t.cashTendered : p.amount)}</span></div>)}
        {t.cashTendered != null && t.cashTendered > 0 && !t.payments.some((p: any) => p.method === 'cash') && <div className="tk-row"><span>Espèces reçues</span><span>{money(t.cashTendered)}</span></div>}
        {t.change > 0 && <div className="tk-row"><b>Monnaie rendue</b><b>{money(t.change)}</b></div>}
      </div>
      <div className="tk-sub">
        {t.vat.map((v: any) => <div key={v.rate} className="tk-row"><span>TVA {v.rate} % sur {money(v.ht)}</span><span>{money(v.vat)}</span></div>)}
        <div className="tk-row"><span>Total HT</span><span>{money(t.totalHt)}</span></div>
      </div>
      {t.creditedAmount > 0 && <div className="tk-sub"><div className="tk-row"><span>Avoir émis</span><span>− {money(t.creditedAmount)}</span></div></div>}
      <p className="tk-foot">Merci de votre visite et à bientôt !<br />Articles : {t.lines.reduce((a: number, l: any) => a + l.quantity, 0).toLocaleString('fr-FR')}</p>
    </div>
  );
}

/** Rapport de clôture (Z) d'une session de caisse. */
export function ZReport({ r }: { r: any }) {
  const s = r.session;
  return (
    <div className="tk print-area">
      <Head company={r.company} title={`Rapport ${s.status === 'closed' ? 'de clôture (Z)' : 'intermédiaire (X)'}`} sub={<span>{s.registerName} · session {s.number}</span>} />
      <div className="tk-sub">
        <div className="tk-row"><span>Ouverture</span><span>{time(s.openedAt)}</span></div>
        <div className="tk-row"><span>par</span><span>{s.openedBy}</span></div>
        {s.closedAt && <><div className="tk-row"><span>Clôture</span><span>{time(s.closedAt)}</span></div><div className="tk-row"><span>par</span><span>{s.closedBy}</span></div></>}
      </div>
      <div className="tk-sub">
        <div className="tk-row"><span>Tickets</span><span>{r.totals.tickets}</span></div>
        <div className="tk-row"><span>Panier moyen</span><span>{money(r.totals.average)}</span></div>
        <div className="tk-row"><span>Total HT</span><span>{money(r.totals.ht)}</span></div>
        {r.byVat.map((v: any) => <div key={v.rate} className="tk-row"><span>TVA {v.rate} % sur {money(v.ht)}</span><span>{money(v.vat)}</span></div>)}
      </div>
      <div className="tk-total"><span>CHIFFRE TTC</span><b>{money(r.totals.ttc)}</b></div>
      {r.totals.credited > 0 && <div className="tk-sub"><div className="tk-row"><span>Avoirs sur ces tickets</span><span>− {money(r.totals.credited)}</span></div></div>}
      <div className="tk-sub">
        <b>Encaissements</b>
        {r.byMethod.map((m: any) => <div key={m.method} className="tk-row"><span>{POS_METHODS[m.method] ?? m.method} ({m.count})</span><span>{money(m.amount)}</span></div>)}
        {!r.byMethod.length && <span>Aucun encaissement.</span>}
      </div>
      <div className="tk-sub">
        <b>Tiroir-caisse</b>
        <div className="tk-row"><span>Fond de caisse</span><span>{money(s.openingFloat)}</span></div>
        <div className="tk-row"><span>Espèces attendues</span><span>{money(s.expectedCash ?? 0)}</span></div>
        {s.countedCash != null && <div className="tk-row"><span>Espèces comptées</span><span>{money(s.countedCash)}</span></div>}
        {s.difference != null && <div className="tk-row"><b>Écart</b><b>{s.difference > 0 ? '+ ' : ''}{money(s.difference)}</b></div>}
        {s.closingNote && <span>Note : {s.closingNote}</span>}
      </div>
      {r.top.length > 0 && <div className="tk-sub">
        <b>Meilleures ventes</b>
        {r.top.map((x: any, i: number) => <div key={i} className="tk-row"><span>{qty(x.quantity)} × {x.description}</span><span>{money(x.ttc)}</span></div>)}
      </div>}
      <p className="tk-foot">Édité le {time(new Date().toISOString())}</p>
    </div>
  );
}
