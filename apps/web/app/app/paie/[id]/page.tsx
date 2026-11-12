'use client';
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/** Ancienne adresse d'un lot de paie : les lots sont désormais sous « Fiches de paie ». */
export default function LegacyRunRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => { router.replace(`/app/paie/fiches/${id}`); }, [id, router]);
  return null;
}
