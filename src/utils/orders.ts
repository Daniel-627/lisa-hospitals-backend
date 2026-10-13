import { inArray } from "drizzle-orm";
import { db, labOrders, labResults, radiologyOrders, radiologyResults } from "../db";

/** Lab and radiology orders (with their results) for a set of consultations. */
export async function ordersForConsultations(ids: string[]) {
  if (!ids.length) return { lab: [] as any[], radiology: [] as any[] };
  const labs = await db.select().from(labOrders).where(inArray(labOrders.consultationId, ids));
  const labRows = labs.length ? await db.select().from(labResults).where(inArray(labResults.labOrderId, labs.map((l) => l.id))) : [];
  const rads = await db.select().from(radiologyOrders).where(inArray(radiologyOrders.consultationId, ids));
  const radRows = rads.length ? await db.select().from(radiologyResults).where(inArray(radiologyResults.radiologyOrderId, rads.map((r) => r.id))) : [];
  return {
    lab: labs.map((o) => ({ ...o, results: labRows.filter((r) => r.labOrderId === o.id) })),
    radiology: rads.map((o) => ({ ...o, results: radRows.filter((r) => r.radiologyOrderId === o.id) })),
  };
}
