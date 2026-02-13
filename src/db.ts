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
 * Set the RLS context for the current request.
 * This must be called before any data queries.
 *
 * Sets app.current_tenant to the authenticated tenant_id.
 * For customer role, also sets app.current_customer.
 *
 * SET LOCAL ensures the setting only lasts for the current transaction.
 */
export async function setTenantContext(
  sql: postgres.Sql,
  tenant: TenantInfo
): Promise<void> {
  await sql.unsafe(`SET LOCAL app.current_tenant = '${tenant.tenant_id}'`);

  if (tenant.role === 'customer' && tenant.customer_name) {
    await sql.unsafe(`SET LOCAL app.current_customer = '${tenant.customer_name}'`);
  }
}
