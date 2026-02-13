/**
 * Bundle endpoints.
 *
 * GET /api/v1/bundles        — List active bundles with status filter
 * GET /api/v1/bundles/:id    — Get single bundle with related instances
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { parsePagination, paginationOffset } from '../utils/pagination';
import { paginatedResponse, jsonResponse, errorResponse } from '../utils/response';

export async function handleBundlesList(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const pagination = parsePagination(searchParams, env);
  const offset = paginationOffset(pagination);
  const status = searchParams.get('status');

  const filters: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenant.tenant_id];
  let paramIdx = 2;

  if (tenant.role === 'customer' && tenant.customer_name) {
    // Customers don't see the bundle catalog directly — they see through instances
    // But we can still filter if there's a customer_name on bundles
  }

  if (status) {
    filters.push(`LOWER(status_name) = LOWER($${paramIdx})`);
    params.push(status);
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  const countResult = await sql.unsafe(
    `SELECT COUNT(*) AS total FROM rpt_bundles WHERE ${whereClause}`,
    params
  );
  const total = Number(countResult[0]?.total || 0);

  const dataParams = [...params, pagination.pageSize, offset];
  const data = await sql.unsafe(
    `SELECT
      id, source_id AS bundle_id, bundle_name, bundle_moniker,
      price, currency, formatted_price,
      allowance, allowance_moniker,
      bundle_type_name, offer_type_name, status_name,
      effective_from, effective_to
    FROM rpt_bundles
    WHERE ${whereClause}
    ORDER BY bundle_name ASC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return paginatedResponse(data, total, pagination.page, pagination.pageSize, rateLimit);
}

export async function handleBundleDetail(
  bundleId: string,
  sql: postgres.Sql,
  tenant: TenantInfo,
  rateLimit: RateLimitResult
): Promise<Response> {
  // Fetch the bundle
  const bundles = await sql`
    SELECT
      id, source_id AS bundle_id, bundle_name, bundle_moniker,
      price, currency, formatted_price,
      allowance, allowance_moniker,
      bundle_type_name, offer_type_name, status_name,
      effective_from, effective_to
    FROM rpt_bundles
    WHERE tenant_id = ${tenant.tenant_id}
      AND (id::text = ${bundleId} OR source_id = ${bundleId})
    LIMIT 1
  `;

  if (bundles.length === 0) {
    return errorResponse(404, 'Bundle not found', undefined, rateLimit);
  }

  const bundle = bundles[0];

  // Fetch related instances
  let instanceFilter = '';
  const instanceParams: unknown[] = [tenant.tenant_id, bundle.bundle_moniker];

  if (tenant.role === 'customer' && tenant.customer_name) {
    instanceFilter = ' AND customer_name = $3';
    instanceParams.push(tenant.customer_name);
  }

  const instances = await sql.unsafe(
    `SELECT
      id, iccid, customer_name, endpoint_name,
      bundle_instance_id, start_time, end_time,
      status_name, status_moniker,
      sequence, sequence_max,
      data_used_mb, data_allowance_mb
    FROM rpt_bundle_instances
    WHERE tenant_id = $1
      AND bundle_moniker = $2
      ${instanceFilter}
    ORDER BY start_time DESC
    LIMIT 50`,
    instanceParams
  );

  return jsonResponse({
    bundle,
    instances,
    instance_count: instances.length,
  }, 200, rateLimit);
}
