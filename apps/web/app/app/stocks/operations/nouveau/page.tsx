'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { StockDocument } from '@/components/stock-document';

function NewStockDocument() {
  const t = useSearchParams().get('type');
  const type = t === 'issue' || t === 'transfer' ? t : 'receipt';
  return <StockDocument key={type} type={type} base="/app/stocks/operations" />;
}

export default function NewStockDocumentPage() {
  return <Suspense><NewStockDocument /></Suspense>;
}
