import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Kora ERP', description: 'Gestion commerciale, comptable et RH multi-entreprises' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
