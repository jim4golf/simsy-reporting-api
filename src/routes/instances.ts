/**
 * Bundle instance endpoints.
 *
 * GET /api/v1/bundle-instances — List bundle instances with filters
 *
 * Data quality notes:
 * - Multi-year bundles (2-year, 3-year) create separate bundle_instance_id records
 *   for each year, sharing the same ICCID + bundle_moniker + sequence but with
 *   different start_times. These are all legitimate records.
 * - The host system sometimes has stale statuses. We compute an effective_status:
 *   Active + data exhausted → Depleted; Active + past end_time → Terminated;
 *   Active + within time window → Live; Depleted + data NOT exhausted → reclassified
 *   based on time window (Terminated/Live/Active).
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
  const finalOnly = searchParams.get('final_only');

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
    filters.push(`iccid ILIKE $${paramIdx}`);
    params.push(`%${iccid}%`);
    paramIdx++;
  }

  if (bundleId) {
    filters.push(`(bundle_moniker = $${paramIdx} OR bundle_instance_id = $${paramIdx})`);
    params.push(bundleId);
    paramIdx++;
  }

  if (expiringBefore) {
    filters.push(`end_time <= $${paramIdx}::timestamptz`);
    params.push(expiringBefore);
    paramIdx++;
  }

  if (finalOnly === 'true' || finalOnly === '1') {
    filters.push(`sequence IS NOT NULL AND sequence_max IS NOT NULL AND sequence = sequence_max`);
  }

  const whereClause = filters.join(' AND ');

  // ── CTE that computes effective_status and deduplicates ──
  // Dedup: The Supabase source sometimes syncs the same logical instance with
  // different bundle_instance_id values. True duplicates share the same
  // (iccid, bundle_moniker, sequence, start_time). Multi-year bundles are
  // preserved because they have different start_times.
  // We keep the most recently synced row (latest synced_at).
  //
  // Corrects stale host statuses:
  //   - Active + data_used >= data_allowance → Depleted
  //   - Active + end_time < NOW()           → Terminated
  //   - Otherwise                           → host status_name as-is
  const baseCTE = `
    WITH deduped AS (
      SELECT DISTINCT ON (iccid, bundle_moniker, sequence, start_time)
        id, iccid, customer_name, endpoint_name,
        bundle_name, bundle_moniker, bundle_instance_id,
        start_time, end_time,
        status_name, status_moniker,
        sequence, sequence_max,
        data_used_mb, data_allowance_mb
      FROM rpt_bundle_instances
      WHERE ${whereClause}
      ORDER BY iccid, bundle_moniker, sequence, start_time, synced_at DESC
    ),
    instances AS (
      SELECT
        id, iccid, customer_name, endpoint_name,
        bundle_name, bundle_moniker, bundle_instance_id,
        start_time, end_time,
        status_name, status_moniker,
        sequence, sequence_max,
        data_used_mb, data_allowance_mb,
        CASE
          -- Host says Depleted but data doesn't support it → reclassify
          WHEN LOWER(status_name) = 'depleted' AND data_allowance_mb > 0 AND data_used_mb < data_allowance_mb AND end_time < NOW()
            THEN 'Terminated'
          WHEN LOWER(status_name) = 'depleted' AND data_allowance_mb > 0 AND data_used_mb < data_allowance_mb AND start_time <= NOW() AND end_time >= NOW()
            THEN 'Live'
          WHEN LOWER(status_name) = 'depleted' AND data_allowance_mb > 0 AND data_used_mb < data_allowance_mb
            THEN 'Active'
          -- Host says Active but data is exhausted → Depleted
          WHEN LOWER(status_name) = 'active' AND data_allowance_mb > 0 AND data_used_mb >= data_allowance_mb
            THEN 'Depleted'
          -- Host says Active but past end time → Terminated
          WHEN LOWER(status_name) = 'active' AND end_time < NOW()
            THEN 'Terminated'
          -- Host says Active and currently within time window → Live
          WHEN LOWER(status_name) = 'active' AND start_time <= NOW() AND end_time >= NOW()
            THEN 'Live'
          -- Everything else: trust the host
          ELSE status_name
        END AS effective_status
      FROM deduped
    )`;

  // ── Status filter on effective_status ──
  let statusFilter = '';
  if (status) {
    const sl = status.toLowerCase();
    if (sl === 'live') {
      // Live is now a first-class effective_status (Active + within time window)
      statusFilter = ` AND LOWER(effective_status) = 'live'`;
    } else if (sl === 'active') {
      // Active = all non-reclassified active instances (includes Live + not-yet-started)
      statusFilter = ` AND LOWER(effective_status) IN ('active', 'live')`;
    } else if (sl === 'stalled') {
      // Stalled = computed — mid-sequence instance that ended
      // but the next instance shows no activity.
      statusFilter = ` AND (sequence IS NOT NULL AND sequence_max IS NOT NULL AND sequence < sequence_max AND end_time < NOW() AND LOWER(effective_status) NOT IN ('terminated') AND NOT EXISTS (
        SELECT 1 FROM instances nxt
        WHERE nxt.iccid = instances.iccid
          AND nxt.bundle_moniker = instances.bundle_moniker
          AND nxt.bundle_instance_id = instances.bundle_instance_id
          AND nxt.sequence > instances.sequence
          AND nxt.start_time <= NOW()
          AND (nxt.data_used_mb > 0 OR nxt.start_time > NOW() - INTERVAL '3 days')
      ))`;
    } else {
      // Match on effective_status (which corrects stale Active → Terminated/Depleted)
      statusFilter = ` AND (LOWER(effective_status) = LOWER($${paramIdx}))`;
      params.push(status);
      paramIdx++;
    }
  }

  // ── Count query ──
  const countResult = await sql.unsafe(
    `${baseCTE}
    SELECT COUNT(*) AS total FROM instances WHERE 1=1${statusFilter}`,
    params
  );
  const total = Number(countResult[0]?.total || 0);

  // ── Data query ──
  const dataParams = [...params, pagination.pageSize, offset];
  const data = await sql.unsafe(
    `${baseCTE}
    SELECT
      id, iccid, customer_name, endpoint_name,
      bundle_name, bundle_moniker, bundle_instance_id,
      start_time, end_time,
      effective_status AS status_name, status_moniker,
      sequence, sequence_max,
      data_used_mb, data_allowance_mb
    FROM instances
    WHERE 1=1${statusFilter}
    ORDER BY start_time DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return paginatedResponse(data, total, pagination.page, pagination.pageSize, rateLimit);
}
