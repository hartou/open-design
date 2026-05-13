/**
 * Auth gate component for SaaS mode.
 *
 * When NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set, wraps children with
 * Clerk's ClerkProvider and enforces sign-in. When the key is absent,
 * renders children directly (local / self-hosted mode).
 */
'use client';

import { useEffect, type ReactNode } from 'react';
import {
  ClerkProvider,
  ClerkLoaded,
  ClerkLoading,
  SignIn,
  UserButton,
  useAuth,
} from '@clerk/nextjs';
import { installAuthFetchInterceptor } from '../lib/auth-fetch';

const CLERK_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

function TokenBridge({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  useEffect(() => {
    installAuthFetchInterceptor(() => getToken());
  }, [getToken]);
  return <>{children}</>;
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-panel, #F4EFE6)' }}>
        <p style={{ color: 'var(--text-muted, #888)', fontSize: 14 }}>Loading…</p>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-panel, #F4EFE6)' }}>
        <SignIn routing="hash" />
      </div>
    );
  }

  return (
    <TokenBridge>
      <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 9999 }}>
        <UserButton />
      </div>
      {children}
    </TokenBridge>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) {
    // No Clerk key → local/self-hosted mode, no auth wall.
    return <>{children}</>;
  }

  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <ClerkLoading>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-panel, #F4EFE6)' }}>
          <p style={{ color: 'var(--text-muted, #888)', fontSize: 14 }}>Loading…</p>
        </div>
      </ClerkLoading>
      <ClerkLoaded>
        <AuthenticatedShell>{children}</AuthenticatedShell>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
