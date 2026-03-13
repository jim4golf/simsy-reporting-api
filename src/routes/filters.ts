/**
 * Filter endpoints — populate tenant/customer dropdowns.
 *
 * Security:
 * - S-IMSY platform admin: sees all tenants (except Eclipse) and all customers
 * - Sub-tenant: sees own tenant + children; customers scoped to those tenants
 * - Customer: sees only their own tenant; customers scoped to their tenant
 *
 * GET /api/v1/filters/tenants     — Tenant hierarchy
 * GET /api/v1/filters/customers   — Distinct customer names
 */

import type postgres from 'postgres';
import type { TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { isPlatformAdmin } from '../db';
import { jsonResponse } from '../utils/response';

export async function handleFilterTenants(
  sql: postgres.Sql,
  tenant: TenantInfo,
  rateLimit: RateLimitResult
): Promise<Response> {
  let tenants;

  if (isPlatformAdmin(tenant)) {
    // Platform admin sees all tenants — exclude Eclipse (it's a customer, not a tenant)
    tenants = await sql.unsafe(
      `SELECT tenant_id, tenant_name, parent_tenant_id
       FROM rpt_tenants
       WHERE LOWER(tenant_name) != 'eclipse'
       ORDER BY parent_tenant_id NULLS FIRST, tenant_name ASC`
    );
  } else {
    // Everyone else sees own + children only
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

  if (isPlatformAdmin(tenant)) {
    // Platform admin can optionally scope by tenant_id
    if (tenantId) {
      filters.push(`tenant_id = $${paramIdx}`);
      params.push(tenantId);
      paramIdx++;
    }
  } else if (tenant.role === 'customer' && tenant.customer_name) {
    // Customer: only see their own customer name within their tenant
    filters.push(
      `tenant_id IN (SELECT t.tenant_id FROM rpt_tenants t WHERE t.tenant_id = $${paramIdx} OR t.parent_tenant_id = $${paramIdx})`
    );
    params.push(tenant.tenant_id);
    paramIdx++;
    filters.push(`customer_name = $${paramIdx}`);
    params.push(tenant.customer_name);
    paramIdx++;
  } else {
    // Sub-tenant: scoped to own tenant + children
    filters.push(
      `tenant_id IN (SELECT t.tenant_id FROM rpt_tenants t WHERE t.tenant_id = $${paramIdx} OR t.parent_tenant_id = $${paramIdx})`
    );
    params.push(tenant.tenant_id);
    paramIdx++;
    // Sub-tenant can optionally filter by tenant_id within their scope
    if (tenantId) {
      filters.push(`tenant_id = $${paramIdx}`);
      params.push(tenantId);
      paramIdx++;
    }
  }

  const whereClause = filters.join(' AND ');

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
