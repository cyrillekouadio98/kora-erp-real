'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Ancienne adresse du suivi commercial : il a désormais son propre module, le CRM. */
export default function OldPipelinePage() {
  const router = useRouter();
  useEffect(() => { router.replace('/app/crm'); }, [router]);
  return null;
}
