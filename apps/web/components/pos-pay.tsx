'use client';
import { useMemo, useState } from 'react';
import { money } from '@/lib/format';
import { Alert, Field } from './ui';

const num = (v: string) => Number(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
export type PosPayment = { method: 'cash' | 'mobile_money' | 'card'; amount: number; reference?: string | null };

/** Encaissement : espèces (avec rendu de monnaie), mobile money, carte ; seules les espèces se rendent. */
export function PayDialog({ total, withCard, busy, error, title, onPay, onClose }: {
  total: number; withCard: boolean; busy: boolean; error: string; title?: string; onPay: (payments: PosPayment[]) => void; onClose: () => void;
}) {
  const [pay, setPay] = useState({ cash: '', mobile: '', mobileRef: '', card: '' });
  const cash = num(pay.cash), mobile = num(pay.mobile), card = num(pay.card);
  const received = cash + mobile + card;
  const change = Math.max(0, received - total);
  const missing = Math.max(0, total - received);
  const nonCashOver = mobile + card > total;
  const notes = useMemo(() => {
    const out = new Set<number>();
    for (const step of [500, 1000, 2000, 5000, 10000]) { const v = Math.ceil(total / step) * step; if (v > total) out.add(v); }
    return [...out].sort((a, b) => a - b).slice(0, 4);
  }, [total]);
  const submit = () => onPay([
    ...(cash > 0 ? [{ method: 'cash' as const, amount: cash }] : []),
    ...(mobile > 0 ? [{ method: 'mobile_money' as const, amount: mobile, reference: pay.mobileRef || null }] : []),
    ...(card > 0 ? [{ method: 'card' as const, amount: card }] : []),
    ...(total === 0 ? [{ method: 'cash' as const, amount: 0 }] : []),
  ]);
  return (
    <div className="modal-back" onClick={onClose}>
      <form className="modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (!missing && !nonCashOver) submit(); }}>
        <h2 style={{ margin: 0 }}>{title ?? 'Encaisser'} {money(total)}</h2>
        <Alert>{error}</Alert>
        <Field label="Espèces reçues" type="number" min={0} step="any" autoFocus value={pay.cash} onChange={(e) => setPay({ ...pay, cash: e.target.value })} placeholder="0" />
        <div className="row">
          <button type="button" className="btn sm" onClick={() => setPay({ ...pay, cash: String(Math.max(0, total - mobile - card)) })}>Compte juste</button>
          {notes.map((v) => <button key={v} type="button" className="btn sm" onClick={() => setPay({ ...pay, cash: String(v) })}>{money(v)}</button>)}
        </div>
        <div className="grid2">
          <Field label="Mobile money" type="number" min={0} step="any" value={pay.mobile} onChange={(e) => setPay({ ...pay, mobile: e.target.value })} placeholder="0" />
          <Field label="Référence de la transaction" value={pay.mobileRef} onChange={(e) => setPay({ ...pay, mobileRef: e.target.value })} placeholder="Facultatif" />
          {withCard && <Field label="Carte bancaire" type="number" min={0} step="any" value={pay.card} onChange={(e) => setPay({ ...pay, card: e.target.value })} placeholder="0" />}
        </div>
        <div className="row">
          <button type="button" className="btn sm" onClick={() => setPay({ ...pay, mobile: String(Math.max(0, total - cash - card)) })}>Reste en mobile money</button>
          {withCard && <button type="button" className="btn sm" onClick={() => setPay({ ...pay, card: String(Math.max(0, total - cash - mobile)) })}>Reste par carte</button>}
        </div>
        <div className="pos-change">
          {missing > 0 ? <><span>Reste à payer</span><b style={{ color: 'var(--crit)' }}>{money(missing)}</b></> : <><span>Monnaie à rendre</span><b>{money(change)}</b></>}
        </div>
        {nonCashOver && <Alert kind="warn">Le mobile money et la carte ne peuvent pas dépasser le total : seule la monnaie en espèces se rend.</Alert>}
        {change > 0 && cash < change && !nonCashOver && <Alert kind="warn">La monnaie se rend en espèces : elle ne peut pas dépasser les espèces reçues.</Alert>}
        <div className="row"><button className="btn primary" disabled={busy || missing > 0 || nonCashOver || (change > 0 && cash < change)}>{busy ? 'Enregistrement…' : 'Valider le ticket'}</button>
          <button type="button" className="btn" onClick={onClose}>Retour</button></div>
      </form>
    </div>
  );
}
