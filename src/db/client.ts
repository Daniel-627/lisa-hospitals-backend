import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { WebSocket } from "ws";
import * as schema from "./schema";
import "dotenv/config";

// Node has no global WebSocket constructor that Neon can use on Render.
neonConfig.webSocketConstructor = WebSocket as any;

// Use the *pooled* connection string (host contains "-pooler") in DATABASE_URL.
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
pool.on("error", (err) => console.error("Postgres pool error:", err));

// Unlike neon-http, this driver supports db.transaction(), row locks and advisory locks,
// which the booking, payment and sync code rely on.
export const db = drizzle(pool, { schema });
