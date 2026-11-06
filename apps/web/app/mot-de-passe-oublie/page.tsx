'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Alert, Field, useAction } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <main className="auth">
      <form className="card form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/auth/password-reset', { body: { email } }); setDone(true); }); }}>
        <div><div className="brand">Kora<span> ERP</span></div><p className="muted small">Mot de passe oublié</p></div>
        <Alert>{error}</Alert>
        {done ? (
          <Alert kind="ok">Si un compte existe pour <b>{email}</b>, un e-mail vient d'être envoyé avec un lien valable une heure. Pensez à vérifier vos courriers indésirables.</Alert>
        ) : <>
          <p className="small" style={{ margin: 0 }}>Indiquez l'adresse e-mail de votre compte : vous recevrez un lien pour choisir un nouveau mot de passe.</p>
          <Field label="Adresse e-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn primary" disabled={busy}>Recevoir le lien</button>
        </>}
        <p className="small muted"><Link href="/connexion">Retour à la connexion</Link></p>
      </form>
    </main>
  );
}
