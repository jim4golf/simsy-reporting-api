/**
 * Bundle instance endpoints.
 *
 * GET /api/v1/bundle-instances — List bundle instances with filters
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { tenantFilter } from '../db';
import { parsePagination, paginationOffset } from '../utils/pagination';
import { paginatedResponse } from '../utils/response';

export async function handleInstancesList(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const pagination = parsePagination(searchParams, env);
  const offset = paginationOffset(pagination);
  const iccid = searchParams.get('iccid');
  const bundleId = searchParams.get('bundle_id');
  const status = searchParams.get('status');
  const expiringBefore = searchParams.get('expiring_before');

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

  if (tenant.role === 'customer' && tenant.customer_name) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(tenant.customer_name);
    paramIdx++;
  } else if (searchParams.get('customer')) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(searchParams.get('customer'));
    paramIdx++;
  }

  if (iccid) {
    filters.push(`iccid = $${paramIdx}`);
    params.push(iccid);
    paramIdx++;
  }

  if (bundleId) {
    filters.push(`(bundle_moniker = $${paramIdx} OR bundle_instance_id = $${paramIdx})`);
    params.push(bundleId);
    paramIdx++;
  }

  if (status) {
    const sl = status.toLowerCase();
    if (sl === 'live') {
      // Computed: currently within start and end window
      filters.push(`(start_time <= NOW() AND end_time >= NOW() AND (data_allowance_mb IS NULL OR data_allowance_mb = 0 OR data_used_mb < data_allowance_mb))`);
    } else {
      filters.push(`(LOWER(status_name) = LOWER($${paramIdx}) OR LOWER(status_moniker) = LOWER($${paramIdx}))`);
      params.push(status);
      paramIdx++;
    }
  }

  if (expiringBefore) {
    filters.push(`end_time <= $${paramIdx}::timestamptz`);
    params.push(expiringBefore);
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  const countResult = await sql.unsafe(
    `SELECT COUNT(*) AS total FROM rpt_bundle_instances WHERE ${whereClause}`,
    params
  );
  const total = Number(countResult[0]?.total || 0);

  const dataParams = [...params, pagination.pageSize, offset];
  const data = await sql.unsafe(
    `SELECT
      id, iccid, customer_name, endpoint_name,
      bundle_name, bundle_moniker, bundle_instance_id,
      start_time, end_time,
      status_name, status_moniker,
      sequence, sequence_max,
      data_used_mb, data_allowance_mb
    FROM rpt_bundle_instances
    WHERE ${whereClause}
    ORDER BY start_time DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return paginatedResponse(data, total, pagination.page, pagination.pageSize, rateLimit);
}
