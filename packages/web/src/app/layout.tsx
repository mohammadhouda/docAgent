import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DocAgent - Construction Document Analysis',
  description: 'AI-powered document analysis for construction and engineering projects',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
