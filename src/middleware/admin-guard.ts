/**
 * Admin authorization guard.
 *
 * Returns an error Response if the user is not an admin,
 * or null if they are authorized to proceed.
 */

import type { TenantInfo } from '../types';
import { errorResponse } from '../utils/response';

export function requireAdmin(tenant: TenantInfo): Response | null {
  if (tenant.role !== 'admin') {
    return errorResponse(403, 'Forbidden', 'Admin role required');
  }
  if (tenant.auth_method !== 'jwt') {
    return errorResponse(403, 'Forbidden', 'JWT authentication required for admin operations');
  }
  return null; // authorized
}
