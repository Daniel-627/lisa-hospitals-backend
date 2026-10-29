import crypto from "crypto";
import { z } from "zod";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * File storage, in two kinds.
 *
 *  PUBLIC pictures (doctor photos, news covers, logos) live on Cloudinary. The browser uploads straight to Cloudinary
 *  with a one-off signature from this server (so the API secret never leaves it), and the page stores the https link.
 *
 *  PRIVATE patient files (documents, scans, reports) live in a Cloudflare R2 bucket that has no public access.
 *  A file is stored as a reference, "private:patients/<patient id>/<name>", never as a link. To open one, the app
 *  checks that the person may see that patient and only then hands out a link that stops working after 5 minutes.
 */

// ── Public pictures: Cloudinary ──────────────────────────────────────────────
export const cloudinaryConfigured = () =>
  !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

export const PUBLIC_FOLDERS = { doctor: "lisa-hospitals/doctors", news: "lisa-hospitals/news", logo: "lisa-hospitals/logos" } as const;
export const PUBLIC_FORMATS = "jpg,jpeg,png,webp";
export const PUBLIC_MAX_BYTES = 5 * 1024 * 1024;

/** Cloudinary's signature: the parameters sorted by name, joined as name=value&..., with the API secret on the end, SHA-1. */
export function cloudinarySignature(params: Record<string, string | number>, secret: string) {
  const base = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHash("sha1").update(base + secret).digest("hex");
}

// ── Private files: Cloudflare R2 (S3-compatible) ─────────────────────────────
export const r2Configured = () =>
  !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

let client: S3Client | null = null;
const r2 = () =>
  (client ??= new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  }));

export const PRIVATE_TYPES: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};
export const PRIVATE_MAX_BYTES = 15 * 1024 * 1024;
export const UPLOAD_URL_SECONDS = 300;
export const DOWNLOAD_URL_SECONDS = 300;

const REF = /^private:patients\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9._-]{1,200}$/i;

/** Reads a stored reference. Returns null for anything that is not exactly the shape we create (no path tricks possible). */
export function parsePrivateRef(ref: unknown): { key: string; patientId: string } | null {
  if (typeof ref !== "string") return null;
  const m = REF.exec(ref);
  if (!m || ref.includes("..")) return null;
  return { key: ref.slice("private:".length), patientId: m[1].toLowerCase() };
}
export const isPrivateRef = (v: unknown) => parsePrivateRef(v) !== null;

/** A name safe to put in a storage key: letters, digits, dot, dash, underscore only. */
export const safeFileName = (name: string, ext: string) => {
  const stem = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
  return `${stem}.${ext}`;
};

/** A new, unguessable place for one patient's file, and a 5-minute link the browser can upload to. */
export async function presignUpload(patientId: string, fileName: string, contentType: string, size: number) {
  const ext = PRIVATE_TYPES[contentType];
  const key = `patients/${patientId}/${crypto.randomUUID()}-${safeFileName(fileName, ext)}`;
  const uploadUrl = await getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: UPLOAD_URL_SECONDS, signableHeaders: new Set(["content-type", "content-length"]) },
  );
  return { ref: `private:${key}`, uploadUrl, expiresIn: UPLOAD_URL_SECONDS };
}

/** A 5-minute link for opening one stored file. Only call this after checking who is asking. */
export async function presignDownload(key: string) {
  const name = key.split("/").pop()!.replace(/^[0-9a-f-]{36}-/i, "");
  return getSignedUrl(
    r2(),
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key, ResponseContentDisposition: `inline; filename="${name}"` }),
    { expiresIn: DOWNLOAD_URL_SECONDS },
  );
}

/** A stored file reference or an https link. Used where staff can attach a file to a record. */
export const fileRef = z.string().trim().max(500).refine(
  (v) => isPrivateRef(v) || (/^https:\/\//i.test(v) && URL.canParse(v)),
  "Attach a file, or paste a link that starts with https://",
);
