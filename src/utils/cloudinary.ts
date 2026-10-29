import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";
import { z } from "zod";

/**
 * Files and pictures, all on Cloudinary.
 *
 *  - PUBLIC pictures (doctor photos, news covers) are uploaded as normal public assets. Anyone with the link can see
 *    them, which is the point: they appear on the public website.
 *  - PRIVATE files (patient documents, radiology images and reports) are uploaded with type "authenticated". Their
 *    plain link does NOT work. The backend turns it into a signed link only when it is sending a record to someone
 *    who is already allowed to see that record.
 *
 * The browser uploads straight to Cloudinary with a signature from this server, so files never pass through Render
 * and the secret key never reaches the browser. The server chooses the folder, the file name and the allowed file
 * types, so the browser cannot choose where a file goes or whether it is public.
 */

const CLOUD = () => process.env.CLOUDINARY_CLOUD_NAME || "";
const KEY = () => process.env.CLOUDINARY_API_KEY || "";
const SECRET = () => process.env.CLOUDINARY_API_SECRET || "";

export const cloudinaryConfigured = () => !!(CLOUD() && KEY() && SECRET());

function configure() {
  cloudinary.config({ cloud_name: CLOUD(), api_key: KEY(), api_secret: SECRET(), secure: true });
}

type Role = string;
export type UploadPurpose = {
  access: "public" | "private";
  folder: string;
  roles: Role[];
  formats: string[];
  maxMb: number;
  label: string;
};

const CLINICAL: Role[] = ["admin", "doctor", "nurse", "receptionist", "lab_technician", "radiographer", "pharmacist", "billing_officer"];

export const UPLOAD_PURPOSES = {
  doctor_photo:     { access: "public",  folder: "lisa/public/doctors",       roles: ["admin"],                          formats: ["jpg", "jpeg", "png", "webp"],                  maxMb: 5,  label: "Doctor photo" },
  news_cover:       { access: "public",  folder: "lisa/public/news",          roles: ["admin"],                          formats: ["jpg", "jpeg", "png", "webp"],                  maxMb: 8,  label: "News cover image" },
  patient_document: { access: "private", folder: "lisa/private/documents",    roles: CLINICAL,                           formats: ["pdf", "jpg", "jpeg", "png", "webp"],           maxMb: 10, label: "Patient document" },
  radiology_image:  { access: "private", folder: "lisa/private/radiology",    roles: ["admin", "radiographer", "doctor"], formats: ["jpg", "jpeg", "png", "webp"],                  maxMb: 10, label: "Radiology image" },
  radiology_report: { access: "private", folder: "lisa/private/radiology",    roles: ["admin", "radiographer", "doctor"], formats: ["pdf", "jpg", "jpeg", "png", "webp"],           maxMb: 10, label: "Radiology report" },
} as const satisfies Record<string, UploadPurpose>;

export type PurposeName = keyof typeof UPLOAD_PURPOSES;
export const purposeSchema = z.object({ purpose: z.enum(Object.keys(UPLOAD_PURPOSES) as [PurposeName, ...PurposeName[]]) }).strict();

/** Everything the browser needs to upload one file directly to Cloudinary. The signature is good for about an hour. */
export function signUpload(purposeName: PurposeName) {
  configure();
  const p: UploadPurpose = UPLOAD_PURPOSES[purposeName];
  const timestamp = Math.round(Date.now() / 1000);
  // A random name: unguessable, and a file can never overwrite another.
  const publicId = `${p.folder}/${crypto.randomUUID()}`;
  const signed = {
    timestamp,
    public_id: publicId,
    type: p.access === "private" ? "authenticated" : "upload",
    allowed_formats: p.formats.join(","),
    overwrite: "false",
  };
  const signature = cloudinary.utils.api_sign_request(signed, SECRET());
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD()}/auto/upload`,
    fields: { ...signed, api_key: KEY(), signature },
    access: p.access,
    accept: p.formats.map((f) => `.${f}`).join(","),
    formats: p.formats,
    maxBytes: p.maxMb * 1024 * 1024,
    label: p.label,
  };
}

// ── Reading private files ────────────────────────────────────────────────────
// Stored link of a private file, as Cloudinary returned it: .../<image|raw|video>/authenticated/v123/<folder>/<id>.<ext>
const AUTH_URL = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw|video)\/authenticated\/(?:s--[^/]+--\/)?(?:v(\d+)\/)?([^?#]+)$/;
const PUBLIC_URL = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw|video)\/upload\//;

/** True when the link is a private (authenticated) file in OUR Cloudinary account. */
export const isPrivateFileUrl = (url: string) => {
  const m = AUTH_URL.exec(url);
  return !!m && m[1] === CLOUD();
};

/** True when the link is a public picture in OUR Cloudinary account. */
export const isPublicFileUrl = (url: string) => {
  const m = PUBLIC_URL.exec(url);
  return !!m && m[1] === CLOUD();
};

/**
 * Turns a stored private link into one that opens. Anything that is not one of our private files comes back unchanged
 * (older records with an ordinary link keep working). Only call this for a record the caller is allowed to see.
 */
export function signFileUrl<T extends string | null | undefined>(url: T): T {
  if (!url || !cloudinaryConfigured()) return url;
  const m = AUTH_URL.exec(url);
  if (!m || m[1] !== CLOUD()) return url;
  configure();
  const [, , resourceType, version, rest] = m;
  return cloudinary.url(rest, {
    resource_type: resourceType as "image" | "raw" | "video", type: "authenticated", sign_url: true, secure: true,
    ...(version ? { version } : {}),
  }) as T;
}

/** Signs the file links (fileUrl, imageUrl, reportUrl) of a record, or of every record in a list. */
const FILE_KEYS = ["fileUrl", "imageUrl", "reportUrl"] as const;
export function signRecord<T extends Record<string, any>>(row: T): T {
  if (!row || !cloudinaryConfigured()) return row;
  let out: any = row;
  for (const k of FILE_KEYS) {
    if (typeof row[k] === "string") {
      const s = signFileUrl(row[k]);
      if (s !== row[k]) out = { ...out, [k]: s };
    }
  }
  return out;
}
export const signRecords = <T extends Record<string, any>>(rows: T[]): T[] => rows.map(signRecord);

// ── Writing links ────────────────────────────────────────────────────────────
/**
 * For fields that hold a private file. Once Cloudinary is set up, only a private file uploaded to our account is
 * accepted, so nobody can attach a link that is public or lives somewhere else. Before it is set up, any https link
 * is accepted as before.
 */
export const privateFileUrl = (message = "Upload the file with the upload button") =>
  z.string().trim().url().max(500)
    .refine((u) => u.startsWith("https://"), "Links must start with https://")
    .refine((u) => !cloudinaryConfigured() || isPrivateFileUrl(u), message);
