/**
 * Bundle endpoints.
 *
 * GET /api/v1/bundles        — List active bundles with status filter
 * GET /api/v1/bundles/:id    — Get single bundle with related instances
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { tenantFilter } from '../db';
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

  const tf = tenantFilter(tenant);
  const filters: string[] = [tf.clause];
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;

  // Admin scoping: allow explicit tenant_id filter
  if (tenant.role === 'admin' && searchParams.get('tenant_id')) {
    filters.push(`tenant_id = $${paramIdx}`);
    params.push(searchParams.get('tenant_id'));
    paramIdx++;
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
  const tfDetail = tenantFilter(tenant);
  const bundleParams: unknown[] = [...tfDetail.params, bundleId, bundleId];
  const bundles = await sql.unsafe(
    `SELECT
      id, source_id AS bundle_id, bundle_name, bundle_moniker,
      price, currency, formatted_price,
      allowance, allowance_moniker,
      bundle_type_name, offer_type_name, status_name,
      effective_from, effective_to
    FROM rpt_bundles
    WHERE ${tfDetail.clause}
      AND (id::text = $${tfDetail.nextIdx} OR source_id = $${tfDetail.nextIdx + 1})
    LIMIT 1`,
    bundleParams
  );

  if (bundles.length === 0) {
    return errorResponse(404, 'Bundle not found', undefined, rateLimit);
  }

  const bundle = bundles[0];

  // Fetch related instances
  const tfInst = tenantFilter(tenant);
  const instanceParams: unknown[] = [...tfInst.params, bundle.bundle_moniker];
  let instParamIdx = tfInst.nextIdx + 1;

  let instanceFilter = '';
  if (tenant.role === 'customer' && tenant.customer_name) {
    instanceFilter = ` AND customer_name = $${instParamIdx}`;
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
    WHERE ${tfInst.clause}
      AND bundle_moniker = $${tfInst.nextIdx}
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
