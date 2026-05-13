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
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
} from '@clerk/clerk-react';
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
  return (
    <>
      <SignedIn>
        <TokenBridge>
          {children}
        </TokenBridge>
      </SignedIn>
      <SignedOut>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-panel, #F4EFE6)' }}>
          <SignIn routing="hash" />
        </div>
      </SignedOut>
    </>
  );
}

/**
 * Inline Clerk user button for the app header.
 * Renders the Clerk UserButton when in SaaS mode, nothing otherwise.
 */
export function ClerkUserButton() {
  if (!CLERK_KEY) return null;
  return <UserButton />;
}

export function AuthGate({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) {
    return <>{children}</>;
  }

  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </ClerkProvider>
  );
}
