'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Alert, Field, useAction } from '@/components/ui';

export default function SignupPage() {
  const router = useRouter();
  const [f, setF] = useState({ fullName: '', email: '', password: '', companyName: '' });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <main className="auth">
      <form className="card form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/auth/signup', { body: f }); router.replace('/app'); }); }}>
        <div><div className="brand">Kora<span> ERP</span></div><p className="muted small">Créez votre entreprise : 14 jours d'essai gratuit, sans moyen de paiement.</p></div>
        <Alert>{error}</Alert>
        <Field label="Nom de l'entreprise" required value={f.companyName} onChange={set('companyName')} placeholder="Ex. Boutique Awa SARL" />
        <Field label="Votre nom complet" required autoComplete="name" value={f.fullName} onChange={set('fullName')} />
        <Field label="Adresse e-mail professionnelle" type="email" required autoComplete="email" value={f.email} onChange={set('email')} />
        <Field label="Mot de passe (10 caractères minimum)" type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={set('password')} />
        <button className="btn primary" disabled={busy}>{busy ? 'Création…' : 'Créer mon espace'}</button>
        <p className="small muted">Déjà inscrit ? <Link href="/connexion">Se connecter</Link></p>
      </form>
    </main>
  );
}
