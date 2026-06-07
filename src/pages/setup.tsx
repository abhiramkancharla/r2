import Head from 'next/head';
import { SetupCard } from '@/components/SetupCard';

// Standalone window — loaded only on first run when vault folders are missing.
export default function SetupPage() {
  return (
    <>
      <Head>
        <title>R2 — Setup</title>
      </Head>
      <main className="w-screen h-screen overflow-hidden bg-transparent flex items-start justify-center p-2">
        <SetupCard fullWindow />
      </main>
    </>
  );
}
