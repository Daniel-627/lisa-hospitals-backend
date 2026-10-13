import crypto from "crypto";

const API = "https://api.paystack.co";

export const paystackConfigured = () => !!process.env.PAYSTACK_SECRET_KEY;

async function call(path: string, init?: RequestInit): Promise<any> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) throw new Error(`Paystack ${res.status}: ${body.message ?? "request failed"}`);
  return body.data;
}

/** amountCents is in KES cents, which is Paystack's "subunit" for KES, so it is sent as-is. */
export const initializeTransaction = (p: { email: string; amountCents: number; reference: string; callbackUrl: string; metadata?: Record<string, unknown> }) =>
  call("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: p.email, amount: p.amountCents, currency: "KES", reference: p.reference, callback_url: p.callbackUrl,
      channels: ["mobile_money", "card"], metadata: p.metadata,
    }),
  }) as Promise<{ authorization_url: string; access_code: string; reference: string }>;

export const verifyTransaction = (reference: string) =>
  call(`/transaction/verify/${encodeURIComponent(reference)}`) as Promise<{
    status: string; amount: number; currency: string; reference: string; channel?: string; gateway_response?: string;
  }>;

/** Paystack signs the RAW request body with HMAC-SHA512 using the secret key (x-paystack-signature). */
export function validSignature(rawBody: Buffer | string, signature: string | undefined, secret = process.env.PAYSTACK_SECRET_KEY) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
