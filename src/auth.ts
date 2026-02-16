/**
 * Authentication module.
 *
 * Supports two authentication paths:
 *   1. JWT Bearer token — for browser-based user sessions (email/password + 2FA)
 *   2. CF-Access-Client-Id header — for programmatic/service token access (legacy)
 *
 * Both paths resolve to a TenantInfo object used for RLS context downstream.
 */

import type { Env, TenantInfo } from './types';
import { verifyJWT } from './utils/jwt';
import { hashTokenId } from './utils/crypto';

/**
 * Extract tenant information from the request.
 *
 * Tries (in order):
 *   1. Authorization: Bearer <JWT> header
 *   2. CF-Access-Client-Id header (KV lookup)
 *   3. X-Tenant-Id header (development fallback)
 */
export async function authenticateTenant(
  request: Request,
  env: Env,
): Promise<TenantInfo | null> {
  // Path 1: JWT Bearer token
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return authenticateJWT(token, env);
  }

  // Path 2: Cloudflare Access Client ID (legacy service tokens)
  const clientId = request.headers.get('CF-Access-Client-Id');
  if (clientId) {
    const tenantInfo = (await env.TENANT_KV.get(`token:${clientId}`, 'json')) as Omit<
      TenantInfo,
      'auth_method'
    > | null;
    if (tenantInfo) {
      return { ...tenantInfo, auth_method: 'service_token' };
    }
    console.warn(`[AUTH] Unknown Client ID: ${clientId}`);
    return null;
  }

  // Path 3: Development fallback (direct tenant header)
  const devTenantId = request.headers.get('X-Tenant-Id');
  if (devTenantId) {
    console.warn(`[AUTH] Using development X-Tenant-Id header: ${devTenantId}`);
    return {
      tenant_id: devTenantId,
      tenant_name: devTenantId,
      role: 'tenant',
      auth_method: 'service_token',
    };
  }

  return null;
}

/**
 * Verify a JWT and check that its session hasn't been revoked.
 */
async function authenticateJWT(token: string, env: Env): Promise<TenantInfo | null> {
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;

  // Check session exists in KV (fast revocation check)
  const tokenHash = await hashTokenId(payload.jti);
  const sessionValid = await env.TENANT_KV.get(`session:${tokenHash}`);
  if (!sessionValid) {
    // Session was revoked or expired in KV
    return null;
  }

  return {
    tenant_id: payload.tenant_id,
    tenant_name: payload.tenant_name,
    role: payload.role,
    customer_name: payload.customer_name,
    user_id: payload.sub,
    user_email: payload.email,
    auth_method: 'jwt',
  };
}
