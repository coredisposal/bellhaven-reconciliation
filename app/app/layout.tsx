import type { Metadata } from 'next';
import './globals.css';
import './crm.css';

export const metadata: Metadata = {
  title: 'Bellhaven Review Desk',
  description: 'Review the evidence. Preserve the history. Keep the CRM current.',
  robots: { index: false, follow: false, noarchive: true },
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
