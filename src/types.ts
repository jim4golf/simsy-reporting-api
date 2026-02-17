export interface Env {
  HYPERDRIVE: Hyperdrive;
  TENANT_KV: KVNamespace;
  API_VERSION: string;
  RATE_LIMIT_PER_MINUTE: string;
  DEFAULT_PAGE_SIZE: string;
  MAX_PAGE_SIZE: string;
  /** HS256 signing secret for JWTs (set via wrangler secret put) */
  JWT_SECRET: string;
  /** Brevo API key for sending OTP emails (set via wrangler secret put) */
  BREVO_API_KEY: string;
  /** JWT session lifetime in hours (default: "24") */
  SESSION_TTL_HOURS: string;
  /** OTP code lifetime in minutes (default: "5") */
  OTP_TTL_MINUTES: string;
  /** Sender email address for OTP emails */
  OTP_FROM_EMAIL: string;
  /** Frontend base URL for invite links */
  FRONTEND_URL: string;
}

export interface TenantInfo {
  tenant_id: string;
  tenant_name: string;
  role: 'admin' | 'tenant' | 'customer';
  customer_id?: string;
  customer_name?: string;
  /** Present when authenticated via JWT */
  user_id?: string;
  /** Present when authenticated via JWT */
  user_email?: string;
  /** How the request was authenticated */
  auth_method: 'jwt' | 'service_token';
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

export interface ApiError {
  error: string;
  status: number;
  detail?: string;
}
