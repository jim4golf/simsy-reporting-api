/**
 * Bundle pricing & revenue endpoints.
 *
 * GET  /api/v1/admin/pricing      — Get saved pricing (admin only)
 * PUT  /api/v1/admin/pricing      — Save pricing entries (admin only)
 * GET  /api/v1/revenue/monthly    — Monthly revenue breakdown by tenant or customer
 *
 * Pricing is stored in Cloudflare KV (key: "pricing:all") as a simple
 * array of { tenant_id, bundle_moniker, monthly_price } entries.
 *
 * Revenue = monthly_price × billable_endpoint_count
 * The monthly_price is the fixed monthly charge per endpoint for a bundle.
 * A billable endpoint is one that had a Live, Active, or Depleted
 * bundle instance overlapping the month.
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { tenantFilter } from '../db';
import { jsonResponse, errorResponse } from '../utils/response';

interface PriceEntry {
  tenant_id: string;
  bundle_moniker: string;
  monthly_price: number;
}

interface StoredPricing {
  prices: PriceEntry[];
}

// ── GET /admin/pricing ─────────────────────────────────────────────

export async function handleGetPricing(
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult,
): Promise<Response> {
  const stored = (await env.TENANT_KV.get('pricing:all', 'json')) as StoredPricing | null;
  // Migrate legacy price_per_gb → monthly_price
  const prices = (stored?.prices || []).map((p: any) => ({
    tenant_id: p.tenant_id,
    bundle_moniker: p.bundle_moniker,
    monthly_price: p.monthly_price ?? p.price_per_gb ?? 0,
  }));

  // Enrich with tenant_name and bundle_name
  const [tenants, bundles] = await Promise.all([
    sql.unsafe(`SELECT tenant_id, tenant_name FROM rpt_tenants ORDER BY tenant_name`),
    sql.unsafe(
      `SELECT DISTINCT bundle_moniker, bundle_name
       FROM rpt_bundles
       WHERE LOWER(status_name) = 'active'
       ORDER BY bundle_name`,
    ),
  ]);

  const tenantMap = new Map(tenants.map((t: any) => [t.tenant_id, t.tenant_name]));
  const bundleMap = new Map(bundles.map((b: any) => [b.bundle_moniker, b.bundle_name]));

  const enriched = prices.map((p) => ({
    ...p,
    tenant_name: tenantMap.get(p.tenant_id) || p.tenant_id,
    bundle_name: bundleMap.get(p.bundle_moniker) || p.bundle_moniker,
  }));

  return jsonResponse({ prices: enriched }, 200, rateLimit);
}

// ── PUT /admin/pricing ─────────────────────────────────────────────

export async function handleSavePricing(
  request: Request,
  env: Env,
  rateLimit: RateLimitResult,
): Promise<Response> {
  let body: { prices?: PriceEntry[] };
  try {
    body = await request.json() as { prices?: PriceEntry[] };
  } catch {
    return errorResponse(400, 'Invalid JSON body', undefined, rateLimit);
  }

  if (!body.prices || !Array.isArray(body.prices)) {
    return errorResponse(400, 'Missing prices array', undefined, rateLimit);
  }

  for (let i = 0; i < body.prices.length; i++) {
    const entry = body.prices[i];
    if (!entry.tenant_id || !entry.bundle_moniker || typeof entry.monthly_price !== 'number' || isNaN(entry.monthly_price)) {
      return errorResponse(
        400,
        `Invalid price entry at index ${i}: tenant_id=${JSON.stringify(entry.tenant_id)}, bundle_moniker=${JSON.stringify(entry.bundle_moniker)}, monthly_price=${JSON.stringify(entry.monthly_price)}`,
        undefined,
        rateLimit,
      );
    }
    if (entry.monthly_price < 0) {
      return errorResponse(400, 'monthly_price cannot be negative', undefined, rateLimit);
    }
  }

  // Only store non-zero entries
  const nonZero = body.prices.filter((p) => p.monthly_price > 0);

  await env.TENANT_KV.put('pricing:all', JSON.stringify({ prices: nonZero }));

  return jsonResponse({ status: 'ok', saved: nonZero.length }, 200, rateLimit);
}

// ── GET /revenue/monthly ───────────────────────────────────────────

export async function handleRevenueMonthly(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult,
): Promise<Response> {
  const months = Math.min(Math.max(parseInt(searchParams.get('months') || '6', 10), 1), 24);
  const view = searchParams.get('view') || 'tenant';

  if (view !== 'tenant' && view !== 'customer') {
    return errorResponse(400, 'view must be "tenant" or "customer"', undefined, rateLimit);
  }

  // Build tenant/customer filters (same pattern as instances.ts)
  const tf = tenantFilter(tenant);
  const filters: string[] = [tf.clause];
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;

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

  const whereClause = filters.join(' AND ');

  // The months parameter for generate_series
  const monthsParamIdx = paramIdx;
  params.push((months - 1).toString());
  paramIdx++;

  const data = await sql.unsafe(
    `
    WITH deduped AS (
      SELECT DISTINCT ON (iccid, bundle_moniker, sequence, start_time)
        iccid, customer_name, tenant_id,
        bundle_name, bundle_moniker,
        start_time, end_time,
        status_name,
        data_used_mb, data_allowance_mb
      FROM rpt_bundle_instances
      WHERE ${whereClause}
        AND LOWER(status_name) IN ('active', 'depleted')
      ORDER BY iccid, bundle_moniker, sequence, start_time, synced_at DESC
    ),
    months AS (
      SELECT generate_series(
        date_trunc('month', NOW() - ($${monthsParamIdx} || ' months')::interval),
        date_trunc('month', NOW()),
        '1 month'
      )::date AS month_start
    )
    SELECT
      m.month_start,
      d.bundle_moniker,
      MAX(d.bundle_name) AS bundle_name,
      d.tenant_id,
      d.customer_name,
      COUNT(DISTINCT d.iccid) AS endpoint_count,
      MAX(d.data_allowance_mb) AS allowance_mb
    FROM months m
    JOIN deduped d
      ON d.start_time < (m.month_start + interval '1 month')
      AND d.end_time >= m.month_start
    GROUP BY m.month_start, d.bundle_moniker, d.tenant_id, d.customer_name
    ORDER BY m.month_start, d.bundle_moniker, d.tenant_id, d.customer_name
    `,
    params,
  );

  // Load pricing from KV (handle legacy price_per_gb field)
  const stored = (await env.TENANT_KV.get('pricing:all', 'json')) as StoredPricing | null;
  const priceMap = new Map<string, number>();
  if (stored?.prices) {
    for (const p of stored.prices as any[]) {
      priceMap.set(`${p.tenant_id}:${p.bundle_moniker}`, p.monthly_price ?? p.price_per_gb ?? 0);
    }
  }

  // Enrich tenant names
  const tenantRows = await sql.unsafe(`SELECT tenant_id, tenant_name FROM rpt_tenants`);
  const tenantNameMap = new Map(tenantRows.map((t: any) => [t.tenant_id, t.tenant_name]));

  const rows = data.map((r: any) => {
    const allowanceGb = Number(r.allowance_mb) / 1024;
    const monthlyPrice = priceMap.get(`${r.tenant_id}:${r.bundle_moniker}`) || 0;
    const endpointCount = Number(r.endpoint_count);
    const revenue = monthlyPrice * endpointCount;

    return {
      month: r.month_start,
      bundle_moniker: r.bundle_moniker,
      bundle_name: r.bundle_name,
      tenant_id: r.tenant_id,
      tenant_name: tenantNameMap.get(r.tenant_id) || r.tenant_id,
      customer_name: r.customer_name || 'Unknown',
      group_key: view === 'tenant' ? r.tenant_id : (r.customer_name || 'Unknown'),
      group_name: view === 'tenant'
        ? (tenantNameMap.get(r.tenant_id) || r.tenant_id)
        : (r.customer_name || 'Unknown'),
      endpoint_count: endpointCount,
      allowance_gb: allowanceGb,
      monthly_price: monthlyPrice,
      revenue,
    };
  });

  return jsonResponse({ view, months, data: rows }, 200, rateLimit);
}

// ── GET /revenue/cost-chart ─────────────────────────────────────────

export async function handleRevenueCostChart(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult,
): Promise<Response> {
  const months = Math.min(Math.max(parseInt(searchParams.get('months') || '8', 10), 1), 24);

  // Build tenant/customer filters
  const tf = tenantFilter(tenant);
  const filters: string[] = [tf.clause];
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;

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

  const whereClause = filters.join(' AND ');

  const monthsParamIdx = paramIdx;
  params.push((months - 1).toString());
  paramIdx++;

  // Query 1: Revenue per month (endpoint counts × pricing)
  // Use TO_CHAR for consistent YYYY-MM string keys
  const revenueData = await sql.unsafe(
    `
    WITH deduped AS (
      SELECT DISTINCT ON (iccid, bundle_moniker, sequence, start_time)
        iccid, customer_name, tenant_id,
        bundle_name, bundle_moniker,
        start_time, end_time,
        status_name,
        data_used_mb, data_allowance_mb
      FROM rpt_bundle_instances
      WHERE ${whereClause}
        AND LOWER(status_name) IN ('active', 'depleted')
      ORDER BY iccid, bundle_moniker, sequence, start_time, synced_at DESC
    ),
    months AS (
      SELECT generate_series(
        date_trunc('month', NOW() - ($${monthsParamIdx} || ' months')::interval),
        date_trunc('month', NOW()),
        '1 month'
      )::date AS month_start
    )
    SELECT
      TO_CHAR(m.month_start, 'YYYY-MM') AS month_key,
      d.bundle_moniker,
      d.tenant_id,
      COUNT(DISTINCT d.iccid) AS endpoint_count
    FROM months m
    JOIN deduped d
      ON d.start_time < (m.month_start + interval '1 month')
      AND d.end_time >= m.month_start
    GROUP BY m.month_start, d.bundle_moniker, d.tenant_id
    ORDER BY m.month_start
    `,
    params,
  );

  // Query 2: Wholesale cost per month from actual usage records
  // Build separate params for the usage query
  const usageFilters: string[] = [];
  const usageParams: unknown[] = [];
  let uIdx = 1;

  // Tenant filter on rpt_usage
  if (tenant.role !== 'admin') {
    usageFilters.push(`tenant_id IN (SELECT t.tenant_id FROM rpt_tenants t WHERE t.tenant_id = $${uIdx} OR t.parent_tenant_id = $${uIdx})`);
    usageParams.push(tenant.tenant_id);
    uIdx++;
  }

  if (tenant.role === 'admin' && searchParams.get('tenant_id')) {
    usageFilters.push(`tenant_id = $${uIdx}`);
    usageParams.push(searchParams.get('tenant_id'));
    uIdx++;
  }

  if (tenant.role === 'customer' && tenant.customer_name) {
    usageFilters.push(`customer_name = $${uIdx}`);
    usageParams.push(tenant.customer_name);
    uIdx++;
  } else if (searchParams.get('customer')) {
    usageFilters.push(`customer_name = $${uIdx}`);
    usageParams.push(searchParams.get('customer'));
    uIdx++;
  }

  const usageMonthsIdx = uIdx;
  usageParams.push((months - 1).toString());
  uIdx++;

  const usageWhereClause = usageFilters.length > 0
    ? 'AND ' + usageFilters.join(' AND ')
    : '';

  const costData = await sql.unsafe(
    `
    SELECT
      TO_CHAR(date_trunc('month', usage_date), 'YYYY-MM') AS month_key,
      COALESCE(SUM(buy_charge), 0) AS wholesale_cost
    FROM rpt_usage
    WHERE usage_date >= date_trunc('month', NOW() - ($${usageMonthsIdx} || ' months')::interval)
      ${usageWhereClause}
    GROUP BY date_trunc('month', usage_date)
    ORDER BY date_trunc('month', usage_date)
    `,
    usageParams,
  );

  // Load pricing from KV
  const stored = (await env.TENANT_KV.get('pricing:all', 'json')) as StoredPricing | null;
  const priceMap = new Map<string, number>();
  if (stored?.prices) {
    for (const p of stored.prices as any[]) {
      priceMap.set(`${p.tenant_id}:${p.bundle_moniker}`, p.monthly_price ?? p.price_per_gb ?? 0);
    }
  }

  // Calculate revenue per month using consistent YYYY-MM keys
  const revenueByMonth = new Map<string, number>();
  for (const r of revenueData) {
    const mk = r.month_key as string;
    const monthlyPrice = priceMap.get(`${r.tenant_id}:${r.bundle_moniker}`) || 0;
    const revenue = monthlyPrice * Number(r.endpoint_count);
    revenueByMonth.set(mk, (revenueByMonth.get(mk) || 0) + revenue);
  }

  // Build wholesale cost map
  const costByMonth = new Map<string, number>();
  for (const c of costData) {
    costByMonth.set(c.month_key as string, Number(c.wholesale_cost));
  }

  // Generate the full month series as YYYY-MM strings (guaranteed chronological)
  const monthSeries: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    monthSeries.push(`${yyyy}-${mm}`);
  }

  const chartData = monthSeries.map((m) => {
    const revenue = revenueByMonth.get(m) || 0;
    const wholesale_cost = costByMonth.get(m) || 0;
    return {
      month: m,
      revenue,
      wholesale_cost,
      margin: revenue + wholesale_cost,
    };
  });

  return jsonResponse({ data: chartData }, 200, rateLimit);
}
