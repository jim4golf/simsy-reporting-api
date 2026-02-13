export interface Env {
  HYPERDRIVE: Hyperdrive;
  TENANT_KV: KVNamespace;
  API_VERSION: string;
  RATE_LIMIT_PER_MINUTE: string;
  DEFAULT_PAGE_SIZE: string;
  MAX_PAGE_SIZE: string;
}

export interface TenantInfo {
  tenant_id: string;
  tenant_name: string;
  role: 'tenant' | 'customer';
  customer_id?: string;
  customer_name?: string;
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
