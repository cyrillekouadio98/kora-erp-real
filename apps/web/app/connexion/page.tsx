'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Alert, Field, useAction } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (step === 'password') {
        const r = await api('/auth/login', { body: { email, password } });
        if (r.mfaRequired) return setStep('mfa');
      } else {
        await api('/auth/mfa/verify', { body: { code } });
      }
      const me = await api('/auth/me');
      router.replace(me.companies.length || !me.platformRoles.length ? '/app' : '/console');
    });
  };

  return (
    <main className="auth">
      <form className="card form" onSubmit={submit}>
        <div><div className="brand">Kora<span> ERP</span></div><p className="muted small">Connectez-vous à votre espace de gestion.</p></div>
        <Alert>{error}</Alert>
        {step === 'password' ? (
          <>
            <Field label="Adresse e-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <Field label="Mot de passe" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        ) : (
          <Field label="Code de double authentification (6 chiffres)" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
        )}
        <button className="btn primary" disabled={busy}>{busy ? 'Connexion…' : step === 'password' ? 'Se connecter' : 'Valider le code'}</button>
        <p className="small muted">{step === 'password' && <><Link href="/mot-de-passe-oublie">Mot de passe oublié ?</Link> · </>}Pas encore de compte ? <Link href="/inscription">Créer mon entreprise</Link></p>
      </form>
    </main>
  );
}
