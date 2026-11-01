import { Router } from "express";
import { authenticate, authorize } from "../middleware/clerk.middleware";
import { rateLimit } from "../utils/rateLimit";
import * as c from "../controllers/chat.controller";

export const chatRoutes = Router();

const patient = [authenticate, authorize("patient")];
const front   = [authenticate, authorize("admin", "receptionist")];   // the shared "Lisa" inbox: front desk and admin
const send    = rateLimit({ windowMs: 60_000, max: 40 });

// Patient: only ever sees "Lisa"
chatRoutes.get("/mine",         ...patient, c.mineMessages);
chatRoutes.post("/mine",        ...patient, send, c.mineSend);
chatRoutes.post("/mine/read",   ...patient, c.mineRead);
chatRoutes.get("/mine/unread",  ...patient, c.mineUnread);
chatRoutes.get("/visits",       ...patient, c.myVisits);

// Staff inbox
chatRoutes.get("/threads",          ...front, c.staffList);
chatRoutes.get("/threads/unread",   ...front, c.staffUnread);
chatRoutes.get("/threads/:id",       ...front, c.staffOpen);
chatRoutes.post("/threads/:id",      ...front, send, c.staffReply);
