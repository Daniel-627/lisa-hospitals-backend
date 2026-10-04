import { db, auditLogs } from "../db";
import type { ClerkRequest } from "../middleware/clerk.middleware";

/**
 * Records a sensitive action in audit_logs. Best-effort: a logging failure must never break the request,
 * so call it AFTER the main work has committed (not inside a transaction).
 */
export async function audit(
  req: ClerkRequest,
  action: string,
  table: string,
  recordId?: string | null,
  oldValues?: unknown,
  newValues?: unknown,
) {
  try {
    await db.insert(auditLogs).values({
      userId: req.clerkUser?.dbUserId,
      action,
      table,
      recordId: recordId ?? null,
      oldValues: oldValues == null ? null : JSON.stringify(oldValues),
      newValues: newValues == null ? null : JSON.stringify(newValues),
      ipAddress: req.ip ? req.ip.slice(0, 45) : null,
      userAgent: req.get("user-agent")?.slice(0, 500) ?? null,
    });
  } catch (err) {
    console.error("audit log failed:", err);
  }
}
