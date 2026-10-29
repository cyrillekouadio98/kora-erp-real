'use client';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Alert, useAction } from '@/components/ui';

/** Page du prestataire de paiement de test (environnement de développement uniquement). */
function SandboxPay() {
  const router = useRouter();
  const invoice = useSearchParams().get('invoice') ?? '';
  const { busy, error, run } = useAction();
  return (
    <main className="auth">
      <div className="card form">
        <h1>Paiement de test</h1>
        <Alert kind="info">Simulation du prestataire de paiement. Aucun argent n'est débité ; en production, cette page sera celle du prestataire choisi (mobile money, carte).</Alert>
        <Alert>{error}</Alert>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`/dev/sandbox/pay/${invoice}`, { method: 'POST', body: {} }); router.replace('/app/abonnement?paye=1'); })}>Simuler un paiement réussi</button>
          <button className="btn" onClick={() => router.replace('/app/abonnement')}>Annuler</button>
        </div>
      </div>
    </main>
  );
}
export default function Page() { return <Suspense><SandboxPay /></Suspense>; }
