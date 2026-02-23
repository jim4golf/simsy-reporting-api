/**
 * Usage report endpoints.
 *
 * GET /api/v1/usage/summary  — Aggregated usage with daily/monthly/annual grouping
 * GET /api/v1/usage/records  — Paginated raw usage records
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { tenantFilter } from '../db';
import { parsePagination, paginationOffset } from '../utils/pagination';
import { jsonResponse, paginatedResponse, errorResponse } from '../utils/response';

export async function handleUsageSummary(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const groupBy = searchParams.get('group_by') || 'daily';
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!['daily', 'monthly', 'annual'].includes(groupBy)) {
    return errorResponse(400, 'Invalid group_by parameter', 'Must be: daily, monthly, or annual', rateLimit);
  }

  // Select the appropriate materialised view
  const viewMap: Record<string, { view: string; dateCol: string }> = {
    daily: { view: 'mv_usage_daily', dateCol: 'day' },
    monthly: { view: 'mv_usage_monthly', dateCol: 'month' },
    annual: { view: 'mv_usage_annual', dateCol: 'year' },
  };
  const { view, dateCol } = viewMap[groupBy];

  // Build date filter
  const tf = tenantFilter(tenant);
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;
  let dateFilter = '';

  if (from) {
    dateFilter += ` AND ${dateCol} >= $${paramIdx}::date`;
    params.push(from);
    paramIdx++;
  }
  if (to) {
    dateFilter += ` AND ${dateCol} <= $${paramIdx}::date`;
    params.push(to);
    paramIdx++;
  }

  // Admin scoping: allow explicit tenant_id + customer filters
  if (tenant.role === 'admin' && searchParams.get('tenant_id')) {
    dateFilter += ` AND tenant_id = $${paramIdx}`;
    params.push(searchParams.get('tenant_id'));
    paramIdx++;
  }

  // Customer scoping
  let customerFilter = '';
  const customerParam = searchParams.get('customer');
  if (tenant.role === 'customer' && tenant.customer_name) {
    customerFilter = ` AND customer_name = $${paramIdx}`;
    params.push(tenant.customer_name);
    paramIdx++;
  } else if (customerParam) {
    customerFilter = ` AND customer_name = $${paramIdx}`;
    params.push(customerParam);
    paramIdx++;
  }

  // Get summary totals
  const summaryQuery = `
    SELECT
      COALESCE(SUM(total_consumption), 0) AS total_consumption,
      COALESCE(SUM(total_bytes), 0) AS total_bytes,
      COALESCE(SUM(total_buy), 0) AS total_buy,
      COALESCE(SUM(total_sell), 0) AS total_sell,
      COALESCE(SUM(record_count), 0) AS total_records
    FROM ${view}
    WHERE ${tf.clause} ${dateFilter} ${customerFilter}
  `;

  const summary = await sql.unsafe(summaryQuery, params);

  // Get grouped data
  const dataQuery = `
    SELECT
      ${dateCol}::text AS date,
      COALESCE(SUM(total_consumption), 0) AS consumption,
      COALESCE(SUM(total_charged), 0) AS total_charged,
      COALESCE(SUM(total_bytes), 0) AS total_bytes,
      COALESCE(SUM(total_buy), 0) AS buy_total,
      COALESCE(SUM(total_sell), 0) AS sell_total,
      COALESCE(SUM(record_count), 0) AS records
    FROM ${view}
    WHERE ${tf.clause} ${dateFilter} ${customerFilter}
    GROUP BY ${dateCol}
    ORDER BY ${dateCol} ASC
  `;

  const data = await sql.unsafe(dataQuery, params);

  return jsonResponse({
    tenant: tenant.tenant_name,
    period: {
      from: from || 'all',
      to: to || 'now',
      group_by: groupBy,
    },
    summary: {
      total_consumption: Number(summary[0]?.total_consumption || 0),
      total_bytes: Number(summary[0]?.total_bytes || 0),
      total_buy: Number(summary[0]?.total_buy || 0),
      total_sell: Number(summary[0]?.total_sell || 0),
      total_records: Number(summary[0]?.total_records || 0),
    },
    data: data.map((row) => ({
      date: row.date,
      consumption: Number(row.consumption),
      total_charged: Number(row.total_charged),
      total_bytes: Number(row.total_bytes),
      buy_total: Number(row.buy_total),
      sell_total: Number(row.sell_total),
      records: Number(row.records),
    })),
  }, 200, rateLimit);
}

/**
 * GET /api/v1/usage/breakdown — Usage grouped by customer or endpoint
 * Query params: group_by_field=customer|endpoint, from, to, limit
 */
export async function handleUsageBreakdown(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const field = searchParams.get('group_by_field') || 'customer';
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  if (!['customer', 'endpoint'].includes(field)) {
    return errorResponse(400, 'Invalid group_by_field', 'Must be: customer or endpoint', rateLimit);
  }

  const groupCol = field === 'customer' ? 'customer_name' : 'endpoint_description';

  const tf = tenantFilter(tenant);
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;
  let dateFilter = '';

  if (from) {
    dateFilter += ` AND usage_date >= $${paramIdx}::date`;
    params.push(from);
    paramIdx++;
  }
  if (to) {
    dateFilter += ` AND usage_date <= $${paramIdx}::date`;
    params.push(to);
    paramIdx++;
  }

  if (tenant.role === 'admin' && searchParams.get('tenant_id')) {
    dateFilter += ` AND tenant_id = $${paramIdx}`;
    params.push(searchParams.get('tenant_id'));
    paramIdx++;
  }

  params.push(limit);

  const query = `
    SELECT
      COALESCE(${groupCol}, 'Unknown') AS name,
      COUNT(*) AS record_count,
      COALESCE(SUM(charged_consumption), 0) AS total_charged,
      COALESCE(SUM(uplink_bytes + downlink_bytes), 0) AS total_bytes,
      COALESCE(SUM(buy_charge), 0) AS total_buy,
      COALESCE(SUM(sell_charge), 0) AS total_sell
    FROM rpt_usage
    WHERE ${tf.clause} ${dateFilter}
    GROUP BY ${groupCol}
    ORDER BY total_charged DESC
    LIMIT $${paramIdx}
  `;

  const data = await sql.unsafe(query, params);

  return jsonResponse({
    field,
    from: from || 'all',
    to: to || 'now',
    data: data.map((row) => ({
      name: row.name,
      record_count: Number(row.record_count),
      total_charged_gb: Number(row.total_charged) / (1024 * 1024 * 1024),
      total_bytes_gb: Number(row.total_bytes) / (1024 * 1024 * 1024),
      total_buy: Number(row.total_buy),
      total_sell: Number(row.total_sell),
    })),
  }, 200, rateLimit);
}

export async function handleUsageRecords(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const pagination = parsePagination(searchParams, env);
  const offset = paginationOffset(pagination);
  const iccid = searchParams.get('iccid');
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  // Build filters
  const tf2 = tenantFilter(tenant);
  const filters: string[] = [tf2.clause];
  const params: unknown[] = [...tf2.params];
  let paramIdx = tf2.nextIdx;

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

  if (from) {
    filters.push(`timestamp >= $${paramIdx}::timestamptz`);
    params.push(from);
    paramIdx++;
  }

  if (to) {
    filters.push(`timestamp <= $${paramIdx}::timestamptz`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  // Count total
  const countResult = await sql.unsafe(
    `SELECT COUNT(*) AS total FROM rpt_usage WHERE ${whereClause}`,
    params
  );
  const total = Number(countResult[0]?.total || 0);

  // Fetch page
  const dataParams = [...params, pagination.pageSize, offset];
  const data = await sql.unsafe(
    `SELECT
      id, iccid, endpoint_name, endpoint_description, customer_name,
      timestamp, usage_date, service_type, charge_type,
      consumption, charged_consumption, uplink_bytes, downlink_bytes,
      bundle_name, bundle_moniker, status_moniker,
      bundle_instance_id, sequence, sequence_max,
      serving_operator_name, serving_country_name,
      buy_charge, buy_currency, sell_charge, sell_currency
    FROM rpt_usage
    WHERE ${whereClause}
    ORDER BY timestamp DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return paginatedResponse(data, total, pagination.page, pagination.pageSize, rateLimit);
}
