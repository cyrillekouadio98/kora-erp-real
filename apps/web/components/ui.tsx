'use client';
import { Fragment, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { Activity, ACTIVITIES, date, money } from '@/lib/format';

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
  if (props.type === 'password') return <PasswordField label={label} {...props} />;
  return <label className="field">{label}<input className="input" {...props} /></label>;
}

/** Champ mot de passe avec un bouton pour afficher ou masquer la saisie (vérifier avant de valider). */
function PasswordField({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <label className="field">{label}
      <span className="pw-wrap">
        <input className="input" {...props} type={shown ? 'text' : 'password'} />
        <button type="button" className="pw-toggle" aria-pressed={shown} aria-label={shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
          title={shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} onClick={() => setShown((v) => !v)}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
            {shown && <path d="M3 3l18 18" />}
          </svg>
        </button>
      </span>
    </label>
  );
}

/** Choix de l'activité de l'entreprise (commerce, services ou les deux). */
export function ActivityField({ value, onChange, disabled }: { value: string; onChange: (v: Activity) => void; disabled?: boolean }) {
  const v = (value || 'mixed') as Activity;
  return <label className="field">Activité
    <select className="input" value={v} disabled={disabled} onChange={(e) => onChange(e.target.value as Activity)}>
      {Object.entries(ACTIVITIES).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
    </select>
    <span className="small muted">{ACTIVITIES[v][1]}</span>
  </label>;
}

/** Lignes « Déjà réglé » d'une facture dans le bloc des totaux : une par paiement, datée. */
export function PaidRows({ payments }: { payments: { id?: string; paidOn: string; amount: number }[] }) {
  return <>{payments.map((p, i) => (
    <Fragment key={p.id ?? i}><dt>Déjà réglé le {date(p.paidOn)}</dt><dd>− {money(p.amount)}</dd></Fragment>))}</>;
}

/** Teinte stable tirée d'un texte : même nom, même couleur (initiales, étiquettes). */
export const hue = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Photo d'une personne, ou ses initiales sur une teinte stable (vignettes employés, évaluations). */
export function Avatar({ e, src = e.photo && `/api${e.photo}` }: { e: any; src?: string | null }) {
  if (src) return <img className="vg-photo" src={src} alt="" loading="lazy" />;
  return <div className="vg-photo vg-initials" style={{ '--h': hue(e.fullName ?? e.name ?? `${e.firstName} ${e.lastName}`) } as React.CSSProperties} aria-hidden>{`${(e.firstName ?? '')[0] ?? ''}${(e.lastName ?? '')[0] ?? ''}`.toUpperCase()}</div>;
}

/**
 * Réduit un logo à 600 × 240 px au plus, proportions gardées. PNG pour garder la transparence ;
 * JPEG sur fond blanc si le PNG reste trop lourd (photo).
 */
export function shrinkLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 600 / img.width, 240 / img.height);
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      const g = canvas.getContext('2d')!;
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      let url = canvas.toDataURL('image/png');
      if (url.length > 400_000) { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); url = canvas.toDataURL('image/jpeg', 0.9); }
      URL.revokeObjectURL(img.src); resolve(url);
    };
    img.onerror = () => reject(new Error('Image illisible : choisissez un logo JPEG, PNG ou WebP.'));
    img.src = URL.createObjectURL(file);
  });
}

/** Logo de l'entreprise : aperçu, puis ajouter, changer ou retirer ; onChange reçoit la data URL réduite, ou null. */
export function LogoField({ src, disabled, onChange }: { src: string | null; disabled?: boolean; onChange: (logo: string | null) => void | Promise<void> }) {
  const { busy, error, run } = useAction();
  return (
    <div className="logo-field">
      <div className="logo-preview">{src ? <img src={src} alt="Logo de l'entreprise" /> : <span className="small muted">Aucun logo</span>}</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {!disabled && <div className="row">
          <label className={`btn sm${busy ? ' disabled' : ''}`}>{src ? 'Changer le logo' : 'Ajouter le logo'}
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={busy}
              onChange={(ev) => { const f = ev.target.files?.[0]; if (f) run(async () => onChange(await shrinkLogo(f))); ev.target.value = ''; }} /></label>
          {src && <button type="button" className="btn sm" disabled={busy} onClick={() => run(async () => onChange(null))}>Retirer</button>}
        </div>}
        <p className="small muted" style={{ margin: 0 }}>Repris en tête des devis, factures, bons de commande et bulletins. PNG à fond transparent de préférence.</p>
        <Alert>{error}</Alert>
      </div>
    </div>
  );
}

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
