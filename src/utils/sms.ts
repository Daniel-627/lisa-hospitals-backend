/**
 * SMS sender (Africa's Talking). Pluggable: if SMS isn't configured, nothing is sent and the booking flow
 * falls back to "pending until reception confirms" (no OTP). In non-production the message is logged instead.
 *
 * Env:
 *   AT_USERNAME   Africa's Talking username ("sandbox" for the sandbox)
 *   AT_API_KEY    API key
 *   AT_SENDER_ID  optional approved sender id / shortcode
 */
export const smsConfigured = () => !!(process.env.AT_USERNAME && process.env.AT_API_KEY);

export async function sendSms(to: string, message: string): Promise<boolean> {
  if (!smsConfigured()) {
    if (process.env.NODE_ENV !== "production") console.log(`[sms:dev] to ${to}: ${message}`);
    return false;
  }
  try {
    const sandbox = process.env.AT_USERNAME === "sandbox";
    const url = sandbox
      ? "https://api.sandbox.africastalking.com/version1/messaging"
      : "https://api.africastalking.com/version1/messaging";
    const body = new URLSearchParams({ username: process.env.AT_USERNAME!, to, message });
    if (process.env.AT_SENDER_ID) body.set("from", process.env.AT_SENDER_ID);
    const res = await fetch(url, {
      method: "POST",
      headers: { apiKey: process.env.AT_API_KEY!, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { console.error("sms failed:", res.status, (await res.text()).slice(0, 200)); return false; }
    return true;
  } catch (err) {
    console.error("sms error:", err);
    return false;
  }
}
