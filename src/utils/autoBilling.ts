import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db, visits, consultations, doctors, labOrders, radiologyOrders, prescriptions, admissions,
  invoices, invoiceItems, priceItems,
} from "../db";
import { fromCents, toCents } from "./money";
import { nextNumber } from "./access";

/**
 * Automatic billing. Every billable thing a visit produces (consultation, lab and radiology orders, medicines, ward
 * days) becomes a line on the visit's invoice, exactly once, priced from the price list.
 *
 *  - Idempotent: each line carries a source key ("lab:<order id>") with a unique index, so running this twice, or two
 *    people running it at the same moment, can never double-charge.
 *  - A record with no matching price still gets a line, at 0, marked "needs price", so nothing is forgotten. The billing
 *    desk prices it (or it prices itself once a matching item is added to the price list).
 *  - Prices are copied onto the line when it is raised. Changing the price list later never alters an existing line.
 *  - Billing must never get in the way of care: callers use autoBill(), which logs and swallows any error.
 */

// ── Matching what the doctor typed against the price list ────────────────────
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** Same word, the start of it ("amox" for "amoxicillin"), or the same stem ("abdomen" / "abdominal"). */
const sameWord = (w: string, h: string) => {
  if (w === h) return true;
  if (w.length >= 3 && h.startsWith(w)) return true;
  if (w.length >= 6 && h.length >= 6) {
    let i = 0;
    while (i < w.length && i < h.length && w[i] === h[i]) i++;
    return i >= 5 && i >= Math.min(w.length, h.length) - 2;
  }
  return false;
};

type PriceRow = { id: string; category: string; name: string; unitPrice: string };

/**
 * Finds the one price-list item a free-text name refers to. Every word typed has to appear in the item's name (a typed
 * word may be the start of the item's word), so "Paracetamol 500mg" finds "Paracetamol 500mg x 20 tablets" but
 * "Amoxicillin 250mg" does not find the 500mg one. More than one possible item counts as no match: guessing a price is worse.
 */
export function matchPrice(prices: PriceRow[], category: string, text: string): PriceRow | null {
  const want = tokens(text);
  if (!want.length) return null;
  const pool = prices.filter((p) => p.category === category);
  const exact = pool.filter((p) => tokens(p.name).join(" ") === want.join(" "));
  if (exact.length === 1) return exact[0];
  const hits = pool.filter((p) => {
    const have = tokens(p.name);
    return want.every((w) => have.some((h) => sameWord(w, h)));
  });
  return hits.length === 1 ? hits[0] : null;
}

// ── Dates (Nairobi) ──────────────────────────────────────────────────────────
const eatDate = (d: Date) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

type Want = {
  key: string;
  description: string;
  quantity: number;
  category: string;
  query: string;       // what to look up in the price list
  fixedUnitCents?: number; // already known (the doctor's own fee)
  accrues?: boolean;   // bed days: the quantity keeps growing, the unit price stays as first set
};

export type SyncResult = { invoiceId: string | null; added: number; removed: number; needsPrice: number };

const MANAGED_PREFIXES = ["consult:", "lab:", "rad:", "rx:"]; // lines for these are removed when the record goes away
const isManaged = (key: string) => MANAGED_PREFIXES.some((p) => key.startsWith(p));

export async function recalcInvoice(tx: any, invoiceId: string, removedSomething: boolean) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  const [{ total }] = await tx.select({ total: sql<string>`coalesce(sum(${invoiceItems.totalPrice}), 0)` }).from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
  const totalCents = toCents(total);
  const paidCents = toCents(inv.paidAmount);
  if (inv.paymentStatus === "waived") {
    await tx.update(invoices).set({ totalAmount: fromCents(totalCents), updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    return;
  }
  const status = paidCents <= 0 ? "pending" : paidCents >= totalCents ? "paid" : "partial";
  const refund = removedSomething && paidCents > totalCents ? `\nRefund due: KES ${fromCents(paidCents - totalCents)} (a charged order was cancelled or changed after payment).` : "";
  await tx.update(invoices).set({
    totalAmount: fromCents(totalCents), paymentStatus: status, updatedAt: new Date(),
    ...(refund ? { notes: `${inv.notes ?? ""}${refund}`.trim() } : {}),
  }).where(eq(invoices.id, invoiceId));
}

/** Brings the visit's invoice up to date with what has happened in the visit. Safe to call any time, any number of times. */
export async function syncVisitCharges(visitId: string, outer?: any): Promise<SyncResult> {
  const run = async (tx: any): Promise<SyncResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${visitId}`}))`);

    const [visit] = await tx.select({ id: visits.id, patientId: visits.patientId }).from(visits).where(eq(visits.id, visitId)).limit(1);
    if (!visit) return { invoiceId: null, added: 0, removed: 0, needsPrice: 0 };

    const prices: PriceRow[] = await tx.select({ id: priceItems.id, category: priceItems.category, name: priceItems.name, unitPrice: priceItems.unitPrice })
      .from(priceItems).where(eq(priceItems.isActive, true));

    // 1. What the visit has produced so far.
    const wants = new Map<string, Want>();
    const cons: { id: string; doctorId: string }[] = await tx.select({ id: consultations.id, doctorId: consultations.doctorId }).from(consultations).where(eq(consultations.visitId, visitId));
    const consIds = cons.map((c) => c.id);

    if (cons.length) {
      const [doc] = await tx.select({ fee: doctors.consultationFee, speciality: doctors.speciality }).from(doctors).where(eq(doctors.id, cons[0].doctorId)).limit(1);
      wants.set(`consult:${visitId}`, {
        key: `consult:${visitId}`, description: `Consultation fee${doc?.speciality ? ` (${doc.speciality})` : ""}`, quantity: 1,
        category: "consultation", query: doc?.speciality ?? "", fixedUnitCents: doc?.fee && toCents(doc.fee) > 0 ? toCents(doc.fee) : undefined,
      });
    }
    if (consIds.length) {
      const labs = await tx.select({ id: labOrders.id, name: labOrders.testName }).from(labOrders)
        .where(and(inArray(labOrders.consultationId, consIds), sql`${labOrders.status} <> 'cancelled'`));
      for (const l of labs) wants.set(`lab:${l.id}`, { key: `lab:${l.id}`, description: `Lab: ${l.name}`, quantity: 1, category: "lab", query: l.name });

      const rads = await tx.select({ id: radiologyOrders.id, modality: radiologyOrders.modality, bodyPart: radiologyOrders.bodyPart }).from(radiologyOrders)
        .where(and(inArray(radiologyOrders.consultationId, consIds), sql`${radiologyOrders.status} <> 'cancelled'`));
      for (const r of rads) {
        const label = `${r.modality}${r.bodyPart ? ` - ${r.bodyPart}` : ""}`;
        wants.set(`rad:${r.id}`, { key: `rad:${r.id}`, description: `Imaging: ${label}`, quantity: 1, category: "radiology", query: `${r.modality} ${r.bodyPart ?? ""}` });
      }

      // One course of each medicine. (The price list prices a course, e.g. "Amoxicillin 500mg x 21 capsules".)
      const rx = await tx.select({ id: prescriptions.id, drug: prescriptions.drugName }).from(prescriptions).where(inArray(prescriptions.consultationId, consIds));
      for (const m of rx) wants.set(`rx:${m.id}`, { key: `rx:${m.id}`, description: `Medicine: ${m.drug}`, quantity: 1, category: "pharmacy", query: m.drug });
    }

    // Ward days: one line per bed segment, counted in nights (midnights), at least one day for the stay.
    const stays = await tx.select().from(admissions).where(eq(admissions.visitId, visitId));
    const today = eatDate(new Date());
    for (const a of stays) {
      const start = eatDate(a.segmentStartedAt ?? a.admittedAt);
      const end = a.dischargedAt ? eatDate(a.dischargedAt) : today;
      let days = Math.max(0, daysBetween(start, end));
      if (a.bedSegment === 1 && days === 0) days = 1;
      if (days === 0) continue;
      const key = `bed:${a.id}:${a.bedSegment}`;
      wants.set(key, {
        key, description: `Ward bed: ${a.ward ?? "ward"}${a.bedNumber ? `, bed ${a.bedNumber}` : ""} (per day)`, quantity: days,
        category: "ward", query: a.ward ?? "", accrues: true,
      });
    }

    // 2. What is already on the visit's invoices.
    const existing: { id: string; invoiceId: string; key: string; quantity: number; unit: string; needsPrice: boolean }[] = await tx
      .select({ id: invoiceItems.id, invoiceId: invoiceItems.invoiceId, key: invoiceItems.sourceKey, quantity: invoiceItems.quantity, unit: invoiceItems.unitPrice, needsPrice: invoiceItems.needsPrice })
      .from(invoiceItems).innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
      .where(and(eq(invoices.visitId, visitId), isNotNull(invoiceItems.sourceKey)));
    const have = new Map(existing.map((e) => [e.key, e]));

    // Look a price up for a want: the doctor's own fee, else the price list.
    const priceOf = (w: Want): number | null => {
      if (w.fixedUnitCents) return w.fixedUnitCents;
      if (!w.query.trim()) return null;
      const m = matchPrice(prices, w.category, w.query);
      return m ? toCents(m.unitPrice) : null;
    };

    // 3. Work out the changes.
    const toAdd: { w: Want; unit: number | null }[] = [];
    const toUpdate: { id: string; invoiceId: string; patch: Record<string, unknown> }[] = [];
    for (const w of wants.values()) {
      const line = have.get(w.key);
      if (!line) { toAdd.push({ w, unit: priceOf(w) }); continue; }
      if (line.needsPrice) {
        const unit = priceOf(w);
        if (unit !== null) toUpdate.push({ id: line.id, invoiceId: line.invoiceId, patch: { unitPrice: fromCents(unit), totalPrice: fromCents(unit * w.quantity), quantity: w.quantity, needsPrice: false } });
      } else if (w.accrues && line.quantity !== w.quantity) {
        const unit = toCents(line.unit); // days are added at the rate first charged
        toUpdate.push({ id: line.id, invoiceId: line.invoiceId, patch: { quantity: w.quantity, totalPrice: fromCents(unit * w.quantity) } });
      }
    }
    const toRemove = existing.filter((e) => isManaged(e.key) && !wants.has(e.key));

    if (!toAdd.length && !toUpdate.length && !toRemove.length) {
      const target = existing[0]?.invoiceId ?? null;
      return { invoiceId: target, added: 0, removed: 0, needsPrice: existing.filter((e) => e.needsPrice).length };
    }

    // 4. The invoice that receives new lines: the visit's first one that isn't waived, else a new one.
    let [target] = await tx.select().from(invoices)
      .where(and(eq(invoices.visitId, visitId), sql`${invoices.paymentStatus} <> 'waived'`)).orderBy(asc(invoices.createdAt)).limit(1).for("update");
    if (!target && toAdd.length) {
      [target] = await tx.insert(invoices).values({
        patientId: visit.patientId, visitId, invoiceNumber: await nextNumber("INV", "invoice_number_seq", 9, tx),
        totalAmount: "0.00", paidAmount: "0.00", paymentStatus: "pending", generatedBy: null,
        notes: "Charges are added automatically as the visit goes on.",
      }).returning();
    }

    const touched = new Set<string>();
    if (toAdd.length && target) {
      await tx.insert(invoiceItems).values(toAdd.map(({ w, unit }) => ({
        invoiceId: target.id, description: w.description.slice(0, 300), quantity: w.quantity,
        unitPrice: fromCents(unit ?? 0), totalPrice: fromCents((unit ?? 0) * w.quantity),
        sourceKey: w.key, needsPrice: unit === null,
      }))).onConflictDoNothing();
      touched.add(target.id);
    }
    for (const u of toUpdate) {
      await tx.update(invoiceItems).set(u.patch).where(eq(invoiceItems.id, u.id));
      touched.add(u.invoiceId);
    }
    if (toRemove.length) {
      await tx.delete(invoiceItems).where(inArray(invoiceItems.id, toRemove.map((r) => r.id)));
      for (const r of toRemove) touched.add(r.invoiceId);
    }
    for (const id of touched) await recalcInvoice(tx, id, toRemove.some((r) => r.invoiceId === id));

    const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(invoiceItems).innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
      .where(and(eq(invoices.visitId, visitId), eq(invoiceItems.needsPrice, true)));
    return { invoiceId: target?.id ?? existing[0]?.invoiceId ?? null, added: toAdd.length, removed: toRemove.length, needsPrice: Number(n) };
  };
  return outer ? run(outer) : db.transaction(run);
}

/** For callers in the middle of clinical work: billing trouble is logged, never shown, and never blocks care. */
export async function autoBill(visitId: string | null | undefined, tx?: any): Promise<SyncResult | null> {
  if (!visitId) return null;
  try {
    return await syncVisitCharges(visitId, tx);
  } catch (err) {
    console.error("autoBill failed for visit", visitId, err);
    return null;
  }
}
