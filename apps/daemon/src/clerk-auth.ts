/**
 * Clerk JWT verification middleware for Express.
 *
 * When OD_CLERK_SECRET_KEY is set (SaaS mode), this middleware:
 * 1. Verifies the Bearer JWT on every /api request (except /api/health)
 * 2. Attaches `req.userId` (Clerk's `sub` claim) for downstream handlers
 * 3. Rejects unauthenticated requests with 401
 *
 * When OD_CLERK_SECRET_KEY is absent, the middleware is a no-op pass-through
 * so local / self-hosted deployments continue to work without auth.
 */

import type { Request, Response, NextFunction } from 'express';
import jwksClient from 'jwks-rsa';
import jwt from 'jsonwebtoken';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userDb?: import('better-sqlite3').Database;
      userDataDir?: string;
    }
  }
}

const CLERK_SECRET_KEY = process.env.OD_CLERK_SECRET_KEY || '';
const CLERK_ISSUER = process.env.OD_CLERK_ISSUER || '';  // e.g. https://your-app.clerk.accounts.dev

// Paths that skip authentication (monitoring probes, etc.)
const PUBLIC_PATHS = new Set(['/health', '/version']);

let client: jwksClient.JwksClient | null = null;

function getClient(): jwksClient.JwksClient | null {
  if (!CLERK_ISSUER) return null;
  if (!client) {
    client = jwksClient({
      jwksUri: `${CLERK_ISSUER}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 600_000, // 10 min
      rateLimit: true,
    });
  }
  return client;
}

function getKey(
  header: jwt.JwtHeader,
  callback: (err: Error | null, key?: string) => void,
): void {
  const c = getClient();
  if (!c) {
    callback(new Error('JWKS client not initialized'));
    return;
  }
  c.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export function isSaasMode(): boolean {
  return Boolean(CLERK_SECRET_KEY && CLERK_ISSUER);
}

/**
 * Express middleware that verifies Clerk JWTs.
 * No-op when OD_CLERK_SECRET_KEY / OD_CLERK_ISSUER are unset.
 */
export function clerkAuthMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth in non-SaaS mode
    if (!isSaasMode()) return next();

    // Allow public paths
    if (PUBLIC_PATHS.has(req.path)) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.slice(7);

    jwt.verify(
      token,
      getKey,
      {
        issuer: CLERK_ISSUER,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) {
          console.error('[od] JWT verification failed:', err.message);
          return res.status(401).json({ error: 'Invalid or expired token' });
        }

        const payload = decoded as jwt.JwtPayload;
        req.userId = payload.sub || '';

        if (!req.userId) {
          return res.status(401).json({ error: 'Token missing user identity' });
        }

        next();
      },
    );
  };
}
