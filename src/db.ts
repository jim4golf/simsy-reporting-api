/**
 * Database client for the API Worker.
 * Connects via Hyperdrive as the reader role (subject to RLS).
 */

import postgres from 'postgres';
import type { Env, TenantInfo } from './types';

/** The tenant_id for the S-IMSY platform admin. Only this tenant gets unscoped access. */
export const PLATFORM_TENANT_ID = 's-imsy';

export function createDbClient(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });
}

/**
 * Check if the user is the platform admin (S-IMSY admin).
 * Only this combination gets unscoped, cross-tenant access.
 */
export function isPlatformAdmin(tenant: TenantInfo): boolean {
  return tenant.role === 'admin' && tenant.tenant_id === PLATFORM_TENANT_ID;
}

/**
 * Build a tenant filter clause for use in SQL queries.
 *
 * Security model (hardened):
 * - S-IMSY platform admin (role=admin, tenant_id=s-imsy): sees all data → '1=1'
 * - Sub-tenant (role=tenant OR role=admin on non-s-imsy tenant): sees own + child tenant data
 * - Customer (role=customer): sees only their own tenant's data
 *   (customer_name filtering is applied separately by each route handler)
 *
 * Returns { clause, params, nextIdx }
 */
export function tenantFilter(
  tenant: TenantInfo,
  startIdx: number = 1,
): { clause: string; params: unknown[]; nextIdx: number } {
  // Only the S-IMSY platform admin gets unscoped access
  if (isPlatformAdmin(tenant)) {
    return { clause: '1=1', params: [], nextIdx: startIdx };
  }
  // Everyone else is scoped to their own tenant + any child tenants
  const clause = `tenant_id IN (SELECT t.tenant_id FROM rpt_tenants t WHERE t.tenant_id = $${startIdx} OR t.parent_tenant_id = $${startIdx})`;
  return {
    clause,
    params: [tenant.tenant_id],
    nextIdx: startIdx + 1,
  };
}

/**
 * Execute a callback within a transaction with tenant RLS context.
 * SET LOCAL only works inside BEGIN...COMMIT, so we must wrap
 * all tenant-scoped queries in a transaction.
 */
export async function withTenantContext<T>(
  sql: postgres.Sql,
  tenant: TenantInfo,
  callback: (sql: postgres.Sql) => Promise<T>
): Promise<T> {
  return await sql.begin(async (tx) => {
    const tenantValue = isPlatformAdmin(tenant) ? '*' : tenant.tenant_id;
    await tx.unsafe(`SET LOCAL app.current_tenant = '${tenantValue}'`);

    if (tenant.role === 'customer' && tenant.customer_name) {
      await tx.unsafe(`SET LOCAL app.current_customer = '${tenant.customer_name}'`);
    }

    return await callback(tx);
  });
}
