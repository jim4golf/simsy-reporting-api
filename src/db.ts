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
    await tx.unsafe(`SET LOCAL app.current_tenant = '${tenant.tenant_id}'`);

    if (tenant.role === 'customer' && tenant.customer_name) {
      await tx.unsafe(`SET LOCAL app.current_customer = '${tenant.customer_name}'`);
    }

    return await callback(tx);
  });
}
