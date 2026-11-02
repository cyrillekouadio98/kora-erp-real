'use client';
import { Fragment, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { date, money } from '@/lib/format';

export function Alert({ kind = 'err', children }: { kind?: 'err' | 'warn' | 'ok' | 'info'; children: React.ReactNode }) {
  if (!children) return null;
  return <div className={`alert ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>{children}</div>;
}

export function Pill({ tone = 'mute', children }: { tone?: 'ok' | 'warn' | 'crit' | 'mute'; children: React.ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/** Exécute une action asynchrone avec état de chargement et message d'erreur lisible. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError('');
    try { return await fn(); } catch (e) { setError(errorMessage(e)); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="field">{label}<input className="input" {...props} /></label>;
}

/** Lignes « Déjà réglé » d'une facture dans le bloc des totaux : une par paiement, datée. */
export function PaidRows({ payments }: { payments: { id?: string; paidOn: string; amount: number }[] }) {
  return <>{payments.map((p, i) => (
    <Fragment key={p.id ?? i}><dt>Déjà réglé le {date(p.paidOn)}</dt><dd>− {money(p.amount)}</dd></Fragment>))}</>;
}

/** Teinte stable tirée d'un texte : même nom, même couleur (initiales, étiquettes). */
export const hue = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Réduit l'image choisie à une vignette carrée de 320 px (JPEG), centrée. */
export function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height), size = Math.min(320, side);
      const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
      canvas.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src); resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Image illisible : choisissez une photo JPEG, PNG ou WebP.'));
    img.src = URL.createObjectURL(file);
  });
}
