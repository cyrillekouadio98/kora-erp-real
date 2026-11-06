'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Alert, Field, useAction } from '@/components/ui';

function Invitation() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [info, setInfo] = useState<{ companyName: string; email: string; hasAccount: boolean } | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    api(`/invitations/preview?token=${encodeURIComponent(token)}`).then(setInfo, () => setError("Cette invitation n'est plus valable (expirée, annulée ou déjà utilisée). Demandez-en une nouvelle à votre administrateur."));
  }, [token, setError]);

  return (
    <main className="auth">
      <form className="card form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/invitations/accept', { body: { token, fullName: fullName || undefined, password } }); router.replace('/app'); }); }}>
        <div className="brand">Kora<span> ERP</span></div>
        <Alert>{error}</Alert>
        {info && (
          <>
            <p>Vous êtes invité(e) à rejoindre <b>{info.companyName}</b> avec l'adresse <b>{info.email}</b>.</p>
            {!info.hasAccount && <Field label="Votre nom complet" required value={fullName} onChange={(e) => setFullName(e.target.value)} />}
            <Field label={info.hasAccount ? 'Mot de passe de votre compte' : 'Choisissez un mot de passe (10 caractères minimum)'} type="password" required minLength={info.hasAccount ? 1 : 10} value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="btn primary" disabled={busy}>Rejoindre l'entreprise</button>
          </>
        )}
      </form>
    </main>
  );
}

export default function Page() { return <Suspense><Invitation /></Suspense>; }
