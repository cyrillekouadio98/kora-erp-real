'use client';
import { useParams } from 'next/navigation';
import { StockDocument } from '@/components/stock-document';

export default function InventoryPage() {
  const { id } = useParams<{ id: string }>();
  return <StockDocument id={id} base="/app/stocks/inventaires" />;
}
