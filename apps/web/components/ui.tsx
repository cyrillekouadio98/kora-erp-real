'use client';
import { useState } from 'react';
import { errorMessage } from '@/lib/api';

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
