'use client';
import { useParams } from 'next/navigation';
import { StockDocument } from '@/components/stock-document';

export default function StockDocumentPage() {
  const { id } = useParams<{ id: string }>();
  return <StockDocument id={id} base="/app/stocks/operations" />;
}
