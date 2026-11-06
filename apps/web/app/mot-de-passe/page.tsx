'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Alert, Field, useAction } from '@/components/ui';

function ResetPassword() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();
  return (
    <main className="auth">
      <form className="card form" onSubmit={(e) => {
        e.preventDefault();
        if (password !== confirm) return setError('Les deux mots de passe ne sont pas identiques.');
        run(async () => { await api('/auth/password-reset/confirm', { body: { token, password } }); setDone(true); });
      }}>
        <div><div className="brand">Kora<span> ERP</span></div><p className="muted small">Nouveau mot de passe</p></div>
        <Alert>{error}</Alert>
        {done ? <>
          <Alert kind="ok">Votre mot de passe a été changé. Par sécurité, toutes vos sessions ouvertes ont été fermées.</Alert>
          <Link className="btn primary" href="/connexion">Se connecter</Link>
        </> : <>
          <Field label="Nouveau mot de passe (10 caractères minimum)" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
          <Field label="Confirmez le mot de passe" type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <button className="btn primary" disabled={busy || !token}>Enregistrer</button>
          {!token && <Alert kind="warn">Lien incomplet : ouvrez le lien reçu par e-mail.</Alert>}
        </>}
      </form>
    </main>
  );
}

export default function ResetPasswordPage() { return <Suspense><ResetPassword /></Suspense>; }
