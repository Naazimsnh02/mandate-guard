/**
 * Minimal Airwallex sandbox REST client.
 * - Bearer token cached until ~1 min before expiry (tokens last 30 min).
 * - Amounts sent to Airwallex are MAJOR units.
 * - Every create call carries a request_id; reuse it ONLY when retrying the same operation.
 */
export interface AirwallexConfig {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
}

export class AirwallexError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
    public body: unknown,
  ) {
    super(`Airwallex ${status} ${code ?? ""}: ${message}`);
  }
}

export class AirwallexClient {
  private token?: { value: string; expiresAt: number };
  readonly baseUrl: string;

  constructor(private cfg: AirwallexConfig) {
    this.baseUrl = cfg.baseUrl ?? "https://api.sandbox.airwallex.com";
  }

  static fromEnv(env = process.env): AirwallexClient {
    const clientId = env.AIRWALLEX_CLIENT_ID;
    const apiKey = env.AIRWALLEX_API_KEY;
    if (!clientId || !apiKey) throw new Error("AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY must be set");
    return new AirwallexClient({ clientId, apiKey, baseUrl: env.AIRWALLEX_BASE_URL });
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${this.baseUrl}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.cfg.clientId, "x-api-key": this.cfg.apiKey, "content-length": "0" },
    });
    const body = (await res.json()) as { token?: string; expires_at?: string; code?: string; message?: string };
    if (!res.ok || !body.token) throw new AirwallexError(res.status, body.code, body.message ?? "login failed", body);
    this.token = { value: body.token, expiresAt: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 25 * 60_000 };
    return body.token;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) throw new AirwallexError(res.status, json.code as string | undefined, (json.message as string) ?? res.statusText, json);
    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, body, headers);
  }
}
