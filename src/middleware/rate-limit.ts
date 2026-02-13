/**
 * Rate limiting middleware using Cloudflare KV.
 * Implements a sliding window counter per tenant.
 *
 * Limit: 100 requests per minute per tenant (configurable).
 * Export requests count as 5 requests.
 */

import type { Env } from '../types';

interface RateLimitState {
  count: number;
  resetAt: number; // Unix timestamp (seconds)
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export async function checkRateLimit(
  env: Env,
  tenantId: string,
  weight: number = 1
): Promise<RateLimitResult> {
  const limit = parseInt(env.RATE_LIMIT_PER_MINUTE || '100', 10);
  const key = `ratelimit:${tenantId}`;
  const now = Math.floor(Date.now() / 1000);

  // Get current state
  let state = await env.TENANT_KV.get(key, 'json') as RateLimitState | null;

  // If no state or window expired, start fresh
  if (!state || now >= state.resetAt) {
    state = {
      count: weight,
      resetAt: now + 60, // Reset in 60 seconds
    };
    await env.TENANT_KV.put(key, JSON.stringify(state), {
      expirationTtl: 120, // Auto-expire after 2 minutes
    });
    return {
      allowed: true,
      limit,
      remaining: limit - weight,
      resetAt: state.resetAt,
    };
  }

  // Check if within limit
  const newCount = state.count + weight;
  if (newCount > limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: state.resetAt,
    };
  }

  // Update count
  state.count = newCount;
  await env.TENANT_KV.put(key, JSON.stringify(state), {
    expirationTtl: 120,
  });

  return {
    allowed: true,
    limit,
    remaining: limit - newCount,
    resetAt: state.resetAt,
  };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };
}
