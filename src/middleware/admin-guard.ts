/**
 * Admin authorization guard.
 *
 * Only the S-IMSY platform admin (role=admin, tenant_id=s-imsy) can
 * access /admin/* routes. Any other user — even those with role=admin
 * on a different tenant — is denied.
 */

import type { TenantInfo } from '../types';
import { isPlatformAdmin } from '../db';
import { errorResponse } from '../utils/response';

export function requireAdmin(tenant: TenantInfo): Response | null {
  if (!isPlatformAdmin(tenant)) {
    return errorResponse(403, 'Forbidden', 'Platform admin access required');
  }
  if (tenant.auth_method !== 'jwt') {
    return errorResponse(403, 'Forbidden', 'JWT authentication required for admin operations');
  }
  return null; // authorized
}
