// Minimal Square API client: OAuth, payments, customers. Uses fetch directly (no SDK).
// Docs: https://developer.squareup.com/reference/square

export type SquareEnvironment = 'production' | 'sandbox';

export interface SquareAppConfig {
  appId: string;
  appSecret: string;
  environment: SquareEnvironment;
}

/** Read-only access: who the customers are and what they paid. */
export const SQUARE_SCOPES = ['CUSTOMERS_READ', 'PAYMENTS_READ', 'MERCHANT_PROFILE_READ'];
export const SQUARE_API_VERSION = '2025-01-23';

export const squareBaseUrl = (env: SquareEnvironment) =>
  env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';

export function squareAuthorizeUrl(cfg: SquareAppConfig, state: string): string {
  const params = new URLSearchParams({ client_id: cfg.appId, scope: SQUARE_SCOPES.join(' '), session: 'false', state });
  return `${squareBaseUrl(cfg.environment)}/oauth2/authorize?${params}`;
}

export class SquareApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
  /** The merchant revoked access or the token is no longer valid. */
  get isAuthError() {
    return this.status === 401 || this.code === 'UNAUTHORIZED' || this.code === 'ACCESS_TOKEN_REVOKED' || this.code === 'ACCESS_TOKEN_EXPIRED';
  }
}

export interface SquareTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  merchantId: string;
}

export interface SquareMoney { amount: number; currency: string }

export interface SquarePayment {
  id: string;
  created_at: string;
  status: string; // APPROVED | PENDING | COMPLETED | CANCELED | FAILED
  amount_money?: SquareMoney;
  refunded_money?: SquareMoney;
  customer_id?: string;
  location_id?: string;
}

export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  company_name?: string;
  nickname?: string;
  email_address?: string;
  phone_number?: string;
  preferences?: { email_unsubscribed?: boolean };
}

type FetchFn = typeof fetch;

export function squareClient(cfg: SquareAppConfig, fetchImpl: FetchFn = fetch) {
  const base = squareBaseUrl(cfg.environment);

  async function call<T>(path: string, init: { method?: string; token?: string; body?: unknown; auth?: string } = {}): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.auth ? { Authorization: init.auth } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { errors?: { code?: string; detail?: string }[]; message?: string };
    if (!res.ok) {
      const e = json.errors?.[0];
      throw new SquareApiError(`Square: ${e?.detail ?? json.message ?? `HTTP ${res.status}`}`, res.status, e?.code);
    }
    return json;
  }

  type TokenResponse = { access_token: string; refresh_token: string; expires_at: string; merchant_id: string };
  const toTokens = (t: TokenResponse): SquareTokens => ({
    accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(t.expires_at), merchantId: t.merchant_id,
  });

  return {
    async exchangeCode(code: string): Promise<SquareTokens> {
      return toTokens(await call<TokenResponse>('/oauth2/token', {
        method: 'POST', body: { client_id: cfg.appId, client_secret: cfg.appSecret, code, grant_type: 'authorization_code' },
      }));
    },

    async refresh(refreshToken: string): Promise<SquareTokens> {
      return toTokens(await call<TokenResponse>('/oauth2/token', {
        method: 'POST', body: { client_id: cfg.appId, client_secret: cfg.appSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
      }));
    },

    async revoke(accessToken: string): Promise<void> {
      await call('/oauth2/revoke', { method: 'POST', auth: `Client ${cfg.appSecret}`, body: { client_id: cfg.appId, access_token: accessToken } });
    },

    async merchantName(token: string, merchantId: string): Promise<string | null> {
      const r = await call<{ merchant?: { business_name?: string } }>(`/v2/merchants/${encodeURIComponent(merchantId)}`, { token });
      return r.merchant?.business_name ?? null;
    },

    /** One page of payments created at or after beginTime, oldest first. */
    async listPayments(token: string, beginTime: string, cursor?: string) {
      const q = new URLSearchParams({ begin_time: beginTime, sort_order: 'ASC', limit: '100' });
      if (cursor) q.set('cursor', cursor);
      return call<{ payments?: SquarePayment[]; cursor?: string }>(`/v2/payments?${q}`, { token });
    },

    /** One page of refunds created at or after beginTime. */
    async listRefunds(token: string, beginTime: string, cursor?: string) {
      const q = new URLSearchParams({ begin_time: beginTime, sort_order: 'ASC', limit: '100' });
      if (cursor) q.set('cursor', cursor);
      return call<{ refunds?: { id: string; payment_id: string; status: string; created_at: string }[]; cursor?: string }>(`/v2/refunds?${q}`, { token });
    },

    async getPayment(token: string, id: string): Promise<SquarePayment | null> {
      try {
        return (await call<{ payment: SquarePayment }>(`/v2/payments/${encodeURIComponent(id)}`, { token })).payment;
      } catch (err) {
        if (err instanceof SquareApiError && err.status === 404) return null;
        throw err;
      }
    },

    async listCustomers(token: string, cursor?: string) {
      const q = new URLSearchParams({ limit: '100' });
      if (cursor) q.set('cursor', cursor);
      return call<{ customers?: SquareCustomer[]; cursor?: string }>(`/v2/customers?${q}`, { token });
    },

    async getCustomer(token: string, id: string): Promise<SquareCustomer | null> {
      try {
        return (await call<{ customer: SquareCustomer }>(`/v2/customers/${encodeURIComponent(id)}`, { token })).customer;
      } catch (err) {
        if (err instanceof SquareApiError && err.status === 404) return null; // deleted customer
        throw err;
      }
    },
  };
}

export type SquareClient = ReturnType<typeof squareClient>;

export function squareCustomerName(c: SquareCustomer): string {
  return [c.given_name, c.family_name].filter(Boolean).join(' ').trim() || c.nickname || c.company_name || '';
}
