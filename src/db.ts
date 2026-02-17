/**
 * Database client for the API Worker.
 * Connects via Hyperdrive as the reader role (subject to RLS).
 */

import postgres from 'postgres';
import type { Env, TenantInfo } from './types';

export function createDbClient(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });
}

/**
 * Build a tenant filter clause for use in SQL queries.
 *
 * Needed because some queries hit materialised views (which bypass RLS).
 * - Admin users: see all data → '1=1'
 * - Parent tenants (e.g. s-imsy): see own data + sub-tenant data
 *   → 'tenant_id IN (SELECT tenant_id FROM rpt_tenants WHERE tenant_id = $N OR parent_tenant_id = $N)'
 * - Regular tenants/customers: see only their own tenant_id → 'tenant_id = $N'
 *
 * Returns { clause, params, nextIdx }
 */
export function tenantFilter(
  tenant: TenantInfo,
  startIdx: number = 1,
): { clause: string; params: unknown[]; nextIdx: number } {
  if (tenant.role === 'admin') {
    return { clause: '1=1', params: [], nextIdx: startIdx };
  }
  // Use a subquery to include own tenant + any child tenants
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
    // Admin users see data across all tenants; others are scoped to their own
    const tenantValue = tenant.role === 'admin' ? '*' : tenant.tenant_id;
    await tx.unsafe(`SET LOCAL app.current_tenant = '${tenantValue}'`);

    if (tenant.role === 'customer' && tenant.customer_name) {
      await tx.unsafe(`SET LOCAL app.current_customer = '${tenant.customer_name}'`);
    }

    return await callback(tx);
  });
}
