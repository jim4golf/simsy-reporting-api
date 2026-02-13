/**
 * Authentication module.
 *
 * Resolves the authenticated tenant from Cloudflare Access headers.
 * Uses KV to map service token Client IDs to tenant information.
 */

import type { Env, TenantInfo } from './types';

/**
 * Extract tenant information from the request.
 *
 * Authentication flow:
 * 1. Cloudflare Access validates the service token headers
 * 2. Access injects a JWT into Cf-Access-Jwt-Assertion header
 * 3. We extract the Client ID from the CF-Access-Client-Id header
 * 4. We look up the tenant info from KV using that Client ID
 *
 * For development/testing, also supports a direct X-Tenant-Id header.
 */
export async function authenticateTenant(
  request: Request,
  env: Env
): Promise<TenantInfo | null> {
  // Primary: Cloudflare Access Client ID
  const clientId = request.headers.get('CF-Access-Client-Id');

  if (clientId) {
    const tenantInfo = await env.TENANT_KV.get(`token:${clientId}`, 'json') as TenantInfo | null;
    if (tenantInfo) {
      return tenantInfo;
    }
    console.warn(`[AUTH] Unknown Client ID: ${clientId}`);
    return null;
  }

  // Development fallback: direct tenant header (remove in production)
  const devTenantId = request.headers.get('X-Tenant-Id');
  if (devTenantId) {
    console.warn(`[AUTH] Using development X-Tenant-Id header: ${devTenantId}`);
    return {
      tenant_id: devTenantId,
      tenant_name: devTenantId,
      role: 'tenant',
    };
  }

  return null;
}
