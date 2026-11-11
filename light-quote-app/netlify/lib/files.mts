import { getStore } from "@netlify/blobs";
import { fail } from "./util.mts";

const MAX_IMAGE_BYTES = 3_000_000;
const NAME_PATTERN = /^[a-z0-9-]{1,40}\.(jpg|png|webp)$/;

const store = () => getStore({ name: "lead-files", consistency: "strong" });

export interface ImageFile {
  bytes: Buffer;
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
}

/** Work out the real image type from the first bytes, ignoring whatever the client claimed. */
export function sniffImage(bytes: Buffer): Pick<ImageFile, "mime" | "ext"> | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export function parseImageDataUrl(dataUrl: unknown): ImageFile {
  if (typeof dataUrl !== "string") fail(400, "Photo could not be read");
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) fail(400, "Photo could not be read");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length > MAX_IMAGE_BYTES) fail(413, "Photo is too large");
  const kind = sniffImage(bytes);
  if (!kind) fail(400, "Photos must be JPEG, PNG or WebP");
  return { bytes, ...kind };
}

export function assertFileName(name: string): void {
  if (!NAME_PATTERN.test(name)) fail(404, "Not found");
}

export async function saveFile(leadId: string, name: string, bytes: Buffer, mime: string): Promise<void> {
  assertFileName(name);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await store().set(`${leadId}/${name}`, body, { metadata: { mime } });
}

export async function readFile(leadId: string, name: string): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  assertFileName(name);
  const entry = await store().getWithMetadata(`${leadId}/${name}`, { type: "arrayBuffer" });
  if (entry === null) return null;
  const mime = typeof entry.metadata?.mime === "string" ? entry.metadata.mime : "application/octet-stream";
  return { bytes: entry.data as ArrayBuffer, mime };
}

export async function deleteLeadFiles(leadId: string): Promise<void> {
  const { blobs } = await store().list({ prefix: `${leadId}/` });
  await Promise.all(blobs.map((blob) => store().delete(blob.key)));
}
