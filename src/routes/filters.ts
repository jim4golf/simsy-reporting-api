/**
 * Filter endpoints — populate tenant/customer dropdowns for admin users.
 *
 * GET /api/v1/filters/tenants     — Tenant hierarchy (admin sees all, tenant sees own + children)
 * GET /api/v1/filters/customers   — Distinct customer names, optionally scoped by tenant_id
 */

import type postgres from 'postgres';
import type { TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { jsonResponse } from '../utils/response';

export async function handleFilterTenants(
  sql: postgres.Sql,
  tenant: TenantInfo,
  rateLimit: RateLimitResult
): Promise<Response> {
  let tenants;

  if (tenant.role === 'admin') {
    // Admin sees all tenants
    tenants = await sql.unsafe(
      `SELECT tenant_id, tenant_name, parent_tenant_id
       FROM rpt_tenants
       ORDER BY parent_tenant_id NULLS FIRST, tenant_name ASC`
    );
  } else {
    // Tenant sees own + children
    tenants = await sql.unsafe(
      `SELECT tenant_id, tenant_name, parent_tenant_id
       FROM rpt_tenants
       WHERE tenant_id = $1 OR parent_tenant_id = $1
       ORDER BY parent_tenant_id NULLS FIRST, tenant_name ASC`,
      [tenant.tenant_id]
    );
  }

  return jsonResponse({ tenants }, 200, rateLimit);
}

export async function handleFilterCustomers(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  rateLimit: RateLimitResult
): Promise<Response> {
  const tenantId = searchParams.get('tenant_id');

  const filters: string[] = ['customer_name IS NOT NULL', "customer_name != ''"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (tenant.role === 'admin') {
    // Admin can scope by tenant_id if provided
    if (tenantId) {
      filters.push(`tenant_id = $${paramIdx}`);
      params.push(tenantId);
      paramIdx++;
    }
  } else {
    // Non-admin: scoped to own tenant + children
    filters.push(
      `tenant_id IN (SELECT t.tenant_id FROM rpt_tenants t WHERE t.tenant_id = $${paramIdx} OR t.parent_tenant_id = $${paramIdx})`
    );
    params.push(tenant.tenant_id);
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  // Pull distinct customers from bundle instances (most complete source)
  const customers = await sql.unsafe(
    `SELECT DISTINCT customer_name
     FROM rpt_bundle_instances
     WHERE ${whereClause}
     ORDER BY customer_name ASC`,
    params
  );

  return jsonResponse({
    customers: customers.map((r: any) => r.customer_name),
  }, 200, rateLimit);
}
