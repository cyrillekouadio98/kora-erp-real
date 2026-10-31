'use client';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SalesEditor } from '@/components/sales-editor';

function NewDocument() {
  const router = useRouter();
  const asked = useSearchParams().get('type');
  const type = asked === 'quote' || asked === 'order' ? asked : 'invoice';
  return <SalesEditor key={type} type={type} onSaved={(d) => router.replace(`/app/ventes/${d.id}`)} />;
}

export default function NewDocumentPage() {
  return <Suspense><NewDocument /></Suspense>;
}
