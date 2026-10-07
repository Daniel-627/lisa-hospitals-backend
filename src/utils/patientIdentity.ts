import { sql } from "drizzle-orm";
import { patients, users } from "../db";

/**
 * A patient's name/contact live on the linked user account when they have one (kept in sync with Clerk),
 * or on the patient row itself for walk-ins registered at reception. Queries must LEFT JOIN users and select these.
 */
export const idFirstName = sql<string>`coalesce(${users.firstName}, ${patients.firstName}, '')`;
export const idLastName  = sql<string>`coalesce(${users.lastName}, ${patients.lastName}, '')`;
export const idPhone     = sql<string | null>`coalesce(${users.phone}, ${patients.phone})`;
export const idEmail     = sql<string | null>`coalesce(${users.email}, ${patients.email})`;
