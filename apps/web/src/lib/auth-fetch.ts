/**
 * Authenticated fetch interceptor for SaaS mode.
 *
 * When Clerk is available, transparently injects the session JWT as a
 * Bearer token on every daemon API request. This patches the global
 * `window.fetch` so all existing fetch('/api/…') calls throughout the
 * app automatically carry the auth header — no per-file changes needed.
 *
 * Falls back to plain fetch when Clerk is not initialized (local dev).
 */

let getTokenFn: (() => Promise<string | null>) | null = null;
let patched = false;

/**
 * Called once from the AuthGate bootstrap to hand the interceptor
 * a reference to Clerk's `getToken()` and patch global fetch.
 */
export function installAuthFetchInterceptor(fn: () => Promise<string | null>) {
  getTokenFn = fn;
  if (patched || typeof window === 'undefined') return;
  patched = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function authFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

    const isApiRequest = url.startsWith('/api/') || url.startsWith('/artifacts/');

    if (isApiRequest && getTokenFn) {
      try {
        const token = await getTokenFn();
        if (token) {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${token}`);
          return originalFetch(input, { ...init, headers });
        }
      } catch {
        // Token fetch failed — fall through to unauthenticated request.
      }
    }

    return originalFetch(input, init);
  };
}
