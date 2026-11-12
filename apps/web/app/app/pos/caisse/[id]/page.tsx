'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { lineTotals, PosTicket, POS_METHODS, ttc } from '@/components/pos';
import { Alert, Field, useAction } from '@/components/ui';

interface CartLine { key: string; productId: string | null; description: string; unit: string; unitPrice: number; vatRate: number; quantity: number; stock: number | null }
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const num = (v: string) => Number(String(v).replace(/\s/g, '').replace(',', '.')) || 0;

/** Écran de caisse : scan ou recherche, panier, encaissement, ticket. */
export default function PosScreen() {
  const { id } = useParams<{ id: string }>();
  const { can, ctx, me } = useSession();
  const [register, setRegister] = useState<any>(null);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [contactId, setContactId] = useState('');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [pay, setPay] = useState<{ cash: string; mobile: string; mobileRef: string; card: string } | null>(null);
  const [ticket, setTicket] = useState<any>(null);
  const [closing, setClosing] = useState<any>(null);
  const [closed, setClosed] = useState<any>(null);
  const [opening, setOpening] = useState('');
  const [notice, setNotice] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  const withCard = !!ctx?.entitlements.modules.includes('bank');

  const loadRegister = useCallback(async () => {
    const rows = await api<any[]>('/company/pos/registers');
    setRegister(rows.find((r) => r.id === id) ?? false);
  }, [id]);
  const loadCatalog = useCallback(() => api<any[]>(`/company/pos/registers/${id}/catalog`).then(setCatalog), [id]);
  useEffect(() => {
    run(async () => { await loadRegister(); await loadCatalog(); });
    api<any[]>('/company/contacts?kind=customer').then((c) => setCustomers(c.filter((x) => x.name !== 'Client comptoir')), () => {});
  }, [loadRegister, loadCatalog]); // eslint-disable-line
  // Une fenêtre ouverte garde le focus : la douchette tape vite, le retour au champ de scan ne doit pas le lui voler.
  const modalOpen = useRef(false);
  modalOpen.current = !!(pay || ticket || closing);
  const focus = () => { setTimeout(() => { if (!modalOpen.current) search.current?.focus(); }, 30); };
  // Le champ de scan reprend la main dès qu'aucune fenêtre (encaissement, ticket, clôture) n'est ouverte.
  useEffect(() => { if (!pay && !ticket && !closing) focus(); }, [register, !!pay, !!ticket, !!closing]); // eslint-disable-line

  const session = register?.session;
  const mine = session && session.openedById === me.user.id;
  const totals = useMemo(() => cart.reduce((a, l) => { const x = lineTotals(l); return { ht: a.ht + x.ht, vat: a.vat + x.vat, ttc: a.ttc + x.ttc, items: a.items + l.quantity }; }, { ht: 0, vat: 0, ttc: 0, items: 0 }), [cart]);

  const add = (p: any, quantity = 1) => {
    setNotice('');
    setCart((c) => {
      const i = c.findIndex((l) => l.productId === p.id);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, quantity: Math.round((l.quantity + quantity) * 1000) / 1000 } : l));
      return [...c, { key: `${p.id}-${Date.now()}`, productId: p.id, description: p.name, unit: p.unit, unitPrice: p.salePrice, vatRate: p.vatRate, quantity, stock: p.stock }];
    });
    setQ(''); focus();
  };
  const setQty = (key: string, quantity: number) => setCart((c) => (quantity <= 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, quantity } : l))));

  // Recherche : « 3*6151100000017 » multiplie la quantité ; un code-barres ou un code exact ajoute directement.
  const parsed = useMemo(() => { const m = q.trim().match(/^(\d+(?:[.,]\d+)?)\s*[*x×]\s*(.+)$/i); return m ? { qty: num(m[1]), text: m[2].trim() } : { qty: 1, text: q.trim() }; }, [q]);
  const matches = useMemo(() => {
    const t = norm(parsed.text);
    if (!t) return catalog.slice(0, 60);
    return catalog.filter((p) => norm(p.name).includes(t) || norm(p.code).includes(t) || (p.barcode && p.barcode.includes(parsed.text))).slice(0, 60);
  }, [catalog, parsed]);
  const onEnter = () => {
    if (!parsed.text) { if (cart.length) startPay(); return; }
    const exact = catalog.find((p) => p.barcode === parsed.text || p.code.toLowerCase() === parsed.text.toLowerCase());
    if (exact) return add(exact, parsed.qty);
    if (matches.length === 1) return add(matches[0], parsed.qty);
    setNotice(matches.length ? `${matches.length} articles correspondent : touchez celui à vendre.` : `Aucun article pour « ${parsed.text} ».`);
  };

  const startPay = () => { if (cart.length) setPay({ cash: '', mobile: '', mobileRef: '', card: '' }); };
  const cash = pay ? num(pay.cash) : 0, mobile = pay ? num(pay.mobile) : 0, card = pay ? num(pay.card) : 0;
  const received = cash + mobile + card;
  const change = Math.max(0, received - totals.ttc);
  const missing = Math.max(0, totals.ttc - received);
  const nonCashOver = mobile + card > totals.ttc;
  const notes = useMemo(() => {
    const t = totals.ttc, out = new Set<number>();
    for (const step of [500, 1000, 2000, 5000, 10000]) { const v = Math.ceil(t / step) * step; if (v > t) out.add(v); }
    return [...out].sort((a, b) => a - b).slice(0, 4);
  }, [totals.ttc]);

  const sell = () => run(async () => {
    const payments = [
      ...(cash > 0 ? [{ method: 'cash', amount: cash }] : []),
      ...(mobile > 0 ? [{ method: 'mobile_money', amount: mobile, reference: pay!.mobileRef || null }] : []),
      ...(card > 0 ? [{ method: 'card', amount: card }] : []),
      ...(totals.ttc === 0 ? [{ method: 'cash', amount: 0 }] : []),
    ];
    const t = await api(`/company/pos/sessions/${session.id}/tickets`, { body: {
      contactId: contactId || null, payments,
      lines: cart.map((l) => ({ productId: l.productId, description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, vatRate: l.vatRate })),
    } });
    setTicket(t); setPay(null); setCart([]); setContactId('');
    loadCatalog(); loadRegister();
  });
  const next = () => { setTicket(null); focus(); };

  const openSession = () => run(async () => { await api(`/company/pos/registers/${id}/open`, { body: { openingFloat: num(opening) } }); await loadRegister(); });
  const close = () => run(async () => {
    const r = await api(`/company/pos/sessions/${session.id}/close`, { body: { countedCash: num(closing.counted), note: closing.note || null } });
    setClosed({ ...r, sessionId: session.id }); setClosing(null); await loadRegister();
  });

  // Raccourcis : Entrée encaisse un panier quand la recherche est vide, Échap vide la recherche, F9 encaisse.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F9') { e.preventDefault(); startPay(); }
      if (e.key === 'Escape' && ticket) next();
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line

  if (register === false) return <><h1>Caisse introuvable</h1><p><Link href="/app/pos">Revenir aux caisses</Link></p></>;
  if (!register) return <p className="muted">Chargement de la caisse…</p>;

  if (!session) return (
    <>
      <div className="page-head"><h1>{register.name}</h1><Link className="btn" href="/app/pos">Toutes les caisses</Link></div>
      {closed && <Alert kind={closed.difference === 0 ? 'ok' : 'warn'}>Session clôturée. Espèces attendues {money(closed.expectedCash)}, comptées {money(closed.countedCash)} : {closed.difference === 0 ? 'aucun écart.' : `écart de ${closed.difference > 0 ? '+' : ''}${money(closed.difference)}, inscrit en trésorerie.`}{' '}
        <Link href={`/app/pos/sessions?id=${closed.sessionId}`}>Voir le rapport Z</Link></Alert>}
      <Alert>{error}</Alert>
      {can('pos.create') && !ctx?.readOnly ? <form className="card form" style={{ maxWidth: 440 }} onSubmit={(e) => { e.preventDefault(); openSession(); }}>
        <h2 style={{ margin: 0 }}>La caisse est fermée</h2>
        <Field label="Fond de caisse (FCFA)" type="number" min={0} step="any" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" />
        <div><button className="btn primary" disabled={busy}>Ouvrir la caisse</button></div>
      </form> : <p className="muted">La caisse est fermée.</p>}
    </>
  );

  return (
    <>
    <div className="pos-screen">
      <div className="pos-left">
        <div className="pos-bar">
          <b>{register.name}</b>
          <span className="small muted">Session {session.number} · {session.openedBy} · {session.tickets} ticket{session.tickets > 1 ? 's' : ''} · {money(session.total)}</span>
          <span style={{ flex: 1 }} />
          <Link className="btn sm" href="/app/pos">Caisses</Link>
          {(mine || can('pos.validate')) && <button className="btn sm" onClick={() => setClosing({ counted: '', note: '' })}>Clôturer</button>}
        </div>
        <input ref={search} className="input pos-search" type="search" autoFocus placeholder="Scanner un code-barres ou rechercher un article (3*code pour 3 unités)…"
          value={q} onChange={(e) => { setQ(e.target.value); setNotice(''); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} aria-label="Scanner ou rechercher" />
        {notice && <div className="small" style={{ color: 'var(--warn, #9a6700)' }}>{notice}</div>}
        <div className="pos-grid">
          {matches.map((p) => (
            <button key={p.id} type="button" className="pos-tile" onClick={() => add(p, parsed.qty)}>
              <span className="pos-tile-name">{p.name}</span>
              <b>{money(ttc(p.salePrice, p.vatRate))}</b>
              <span className="small muted">{p.stock == null ? (p.kind === 'service' ? 'Service' : '') : <span style={p.stock <= 0 ? { color: 'var(--crit)' } : undefined}>Stock {p.stock.toLocaleString('fr-FR')} {p.unit}</span>}</span>
            </button>
          ))}
          {!matches.length && <p className="muted">Aucun article. {can('products.create') && <Link href="/app/articles">Créer des articles</Link>}</p>}
        </div>
      </div>

      <aside className="pos-cart">
        <div className="pos-cart-head">
          <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)} aria-label="Client">
            <option value="">Client comptoir</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {cart.length > 0 && <button className="btn sm" onClick={() => { setCart([]); focus(); }}>Vider</button>}
        </div>
        <div className="pos-lines">
          {!cart.length && <p className="muted" style={{ textAlign: 'center', padding: '24px 8px' }}>Scannez ou touchez un article pour commencer le ticket.</p>}
          {cart.map((l) => {
            const over = l.stock != null && l.quantity > l.stock;
            return (
              <div key={l.key} className="pos-line">
                <div className="pos-line-top"><span>{l.description}</span><b>{money(lineTotals(l).ttc)}</b></div>
                <div className="pos-line-qty">
                  <button type="button" className="btn sm" onClick={() => setQty(l.key, Math.round((l.quantity - 1) * 1000) / 1000)} aria-label="Retirer une unité">−</button>
                  <input className="input" type="number" min={0} step="any" value={l.quantity} onChange={(e) => setQty(l.key, num(e.target.value) || 0.001)} aria-label="Quantité" />
                  <button type="button" className="btn sm" onClick={() => setQty(l.key, l.quantity + 1)} aria-label="Ajouter une unité">+</button>
                  <span className="small muted">× {money(ttc(l.unitPrice, l.vatRate))}</span>
                  <button type="button" className="btn sm danger" onClick={() => setQty(l.key, 0)} aria-label="Supprimer la ligne">×</button>
                </div>
                {over && <div className="small" style={{ color: 'var(--crit)' }}>Stock disponible : {l.stock!.toLocaleString('fr-FR')} {l.unit}</div>}
              </div>
            );
          })}
        </div>
        <div className="pos-sum">
          <div className="row small muted" style={{ justifyContent: 'space-between' }}><span>{totals.items.toLocaleString('fr-FR')} article{totals.items > 1 ? 's' : ''} · HT {money(totals.ht)}</span><span>TVA {money(totals.vat)}</span></div>
          <div className="pos-total"><span>Total</span><b>{money(totals.ttc)}</b></div>
          <button className="btn primary pos-pay" disabled={!cart.length || ctx?.readOnly} onClick={startPay}>Encaisser <span className="small">(F9)</span></button>
        </div>
      </aside>
    </div>

      {pay && (
        <div className="modal-back" onClick={() => setPay(null)}>
          <form className="modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (!missing && !nonCashOver) sell(); }}>
            <h2 style={{ margin: 0 }}>Encaisser {money(totals.ttc)}</h2>
            <Alert>{error}</Alert>
            <Field label="Espèces reçues" type="number" min={0} step="any" autoFocus value={pay.cash} onChange={(e) => setPay({ ...pay, cash: e.target.value })} placeholder="0" />
            <div className="row">
              <button type="button" className="btn sm" onClick={() => setPay({ ...pay, cash: String(Math.max(0, totals.ttc - mobile - card)) })}>Compte juste</button>
              {notes.map((v) => <button key={v} type="button" className="btn sm" onClick={() => setPay({ ...pay, cash: String(v) })}>{money(v)}</button>)}
            </div>
            <div className="grid2">
              <Field label="Mobile money" type="number" min={0} step="any" value={pay.mobile} onChange={(e) => setPay({ ...pay, mobile: e.target.value })} placeholder="0" />
              <Field label="Référence de la transaction" value={pay.mobileRef} onChange={(e) => setPay({ ...pay, mobileRef: e.target.value })} placeholder="Facultatif" />
              {withCard && <Field label="Carte bancaire" type="number" min={0} step="any" value={pay.card} onChange={(e) => setPay({ ...pay, card: e.target.value })} placeholder="0" />}
            </div>
            <div className="row">
              <button type="button" className="btn sm" onClick={() => setPay({ ...pay, mobile: String(Math.max(0, totals.ttc - cash - card)) })}>Reste en mobile money</button>
              {withCard && <button type="button" className="btn sm" onClick={() => setPay({ ...pay, card: String(Math.max(0, totals.ttc - cash - mobile)) })}>Reste par carte</button>}
            </div>
            <div className="pos-change">
              {missing > 0 ? <><span>Reste à payer</span><b style={{ color: 'var(--crit)' }}>{money(missing)}</b></> : <><span>Monnaie à rendre</span><b>{money(change)}</b></>}
            </div>
            {nonCashOver && <Alert kind="warn">Le mobile money et la carte ne peuvent pas dépasser le total : seule la monnaie en espèces se rend.</Alert>}
            {change > 0 && cash < change && !nonCashOver && <Alert kind="warn">La monnaie se rend en espèces : elle ne peut pas dépasser les espèces reçues.</Alert>}
            <div className="row"><button className="btn primary" disabled={busy || missing > 0 || nonCashOver || (change > 0 && cash < change)}>{busy ? 'Enregistrement…' : 'Valider le ticket'}</button>
              <button type="button" className="btn" onClick={() => setPay(null)}>Retour</button></div>
          </form>
        </div>
      )}

      {ticket && (
        <div className="modal-back" onClick={next}>
          <div className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="no-print">
              {ticket.change > 0 ? <div className="pos-change big"><span>Monnaie à rendre</span><b>{money(ticket.change)}</b></div>
                : <Alert kind="ok">Ticket {ticket.number} enregistré : {money(ticket.totalTtc)} {ticket.payments.map((p: any) => POS_METHODS[p.method]).join(' + ').toLowerCase()}.</Alert>}
            </div>
            <PosTicket t={ticket} />
            <div className="row no-print">
              <button className="btn primary" autoFocus onClick={next}>Nouvelle vente</button>
              <button className="btn" onClick={() => window.print()}>Imprimer le ticket</button>
            </div>
          </div>
        </div>
      )}

      {closing && (
        <div className="modal-back" onClick={() => setClosing(null)}>
          <form className="modal" style={{ width: 'min(460px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); close(); }}>
            <h2 style={{ margin: 0 }}>Clôturer {register.name}</h2>
            <Alert>{error}</Alert>
            <p className="small muted" style={{ margin: 0 }}>Comptez toutes les espèces du tiroir, fond de caisse compris. Le montant attendu s’affiche après la clôture (comptage à l’aveugle).</p>
            <Field label="Espèces comptées (FCFA)" type="number" min={0} step="any" required autoFocus value={closing.counted} onChange={(e) => setClosing({ ...closing, counted: e.target.value })} />
            <Field label="Note (facultatif)" value={closing.note} onChange={(e) => setClosing({ ...closing, note: e.target.value })} placeholder="Billet abîmé, erreur de rendu…" />
            <div className="row"><button className="btn primary" disabled={busy}>Clôturer la session</button><button type="button" className="btn" onClick={() => setClosing(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
