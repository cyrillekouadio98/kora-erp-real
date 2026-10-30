'use client';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SalesEditor } from '@/components/sales-editor';

function NewPurchase() {
  const router = useRouter();
  const type = useSearchParams().get('type') === 'order' ? 'order' : 'invoice';
  return <SalesEditor key={type} scope="purchases" type={type} onSaved={(d) => router.replace(`/app/achats/${d.id}`)} />;
}

export default function NewPurchasePage() {
  return <Suspense><NewPurchase /></Suspense>;
}
