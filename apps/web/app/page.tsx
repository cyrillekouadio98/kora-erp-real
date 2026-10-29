'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api('/auth/me').then((me) => router.replace(me.companies.length || !me.platformRoles.length ? '/app' : '/console'), () => router.replace('/connexion'));
  }, [router]);
  return <main className="auth"><p className="muted">Chargement…</p></main>;
}
