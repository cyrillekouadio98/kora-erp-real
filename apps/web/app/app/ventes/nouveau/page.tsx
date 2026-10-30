'use client';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SalesEditor } from '@/components/sales-editor';

function NewDocument() {
  const router = useRouter();
  const type = useSearchParams().get('type') === 'quote' ? 'quote' : 'invoice';
  return <SalesEditor key={type} type={type} onSaved={(d) => router.replace(`/app/ventes/${d.id}`)} />;
}

export default function NewDocumentPage() {
  return <Suspense><NewDocument /></Suspense>;
}
