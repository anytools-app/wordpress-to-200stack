import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { MediaManifestEntry } from "./pull.js";

type S3Sender = { send(command: HeadObjectCommand | PutObjectCommand): Promise<{ ETag?: string; Metadata?: Record<string, string> }> };
export type MediaPushOptions = { mediaDir: string; bucket: string; prefix?: string; endpoint?: string; dryRun?: boolean; client?: S3Sender };
export type MediaPushResult = { uploaded: string[]; skipped: string[]; dryRun: boolean };

async function manifestAt(mediaDir: string): Promise<MediaManifestEntry[]> {
  const raw = await readFile(join(mediaDir, "manifest.ndjson"), "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as MediaManifestEntry);
}
function objectKey(prefix: string, path: string): string {
  return [prefix.replace(/^\/+|\/+$/g, ""), path.replace(/^\//, "")].filter(Boolean).join("/");
}
function md5(data: Buffer): string { return createHash("md5").update(data).digest("hex"); }
function missingObject(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404 || (error as { name?: string }).name === "NotFound";
}
function s3Client(endpoint?: string): S3Client {
  return new S3Client({ region: endpoint ? "auto" : (process.env.AWS_REGION ?? "us-east-1"), ...(endpoint ? { endpoint } : {}) });
}

export async function pushMedia(options: MediaPushOptions): Promise<MediaPushResult> {
  const client = options.client ?? s3Client(options.endpoint);
  const prefix = options.prefix ?? "";
  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const entry of await manifestAt(options.mediaDir)) {
    if (entry.status !== "ok") continue;
    const key = objectKey(prefix, entry.path);
    const body = Buffer.from(await readFile(join(options.mediaDir, entry.path)));
    let remote: { ETag?: string; Metadata?: Record<string, string> } | undefined;
    try { remote = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key })); }
    catch (error) { if (!missingObject(error)) throw error; }
    const etag = remote?.ETag?.replaceAll('"', "");
    if (remote && (remote.Metadata?.sha256 === entry.sha256 || etag === md5(body))) { skipped.push(key); continue; }
    uploaded.push(key);
    if (!options.dryRun) await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentType: entry.contentType || undefined, Metadata: { sha256: entry.sha256 } }));
  }
  return { uploaded, skipped, dryRun: Boolean(options.dryRun) };
}
