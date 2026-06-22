import type { AssetKind, FocalPoint, ThumbnailRequest } from "./types";

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
		},
	});
}

export function errorResponse(
	status: number,
	message: string,
	details?: unknown,
): Response {
	return jsonResponse(
		{
			error: {
				message,
				details: details ?? null,
			},
		},
		status,
	);
}

export function normalizeFilename(name: string): string {
	const trimmed = name.trim().toLowerCase();
	const dotIndex = trimmed.lastIndexOf(".");
	const base = dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
	const ext = dotIndex > 0 ? trimmed.slice(dotIndex) : "";
	const slug = base
		.normalize("NFKD")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return `${slug || "file"}${ext}`;
}

export async function sha256Hex(file: Blob): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(new Uint8Array(await file.arrayBuffer()));
	return hasher.digest("hex");
}

export async function sniffMimeType(file: File): Promise<string> {
	if (file.type) return file.type;
	const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "image/jpeg";
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	)
		return "image/png";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
		return "image/gif";
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	if (
		bytes[0] === 0x25 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x44 &&
		bytes[3] === 0x46
	)
		return "application/pdf";
	if (
		bytes[4] === 0x66 &&
		bytes[5] === 0x74 &&
		bytes[6] === 0x79 &&
		bytes[7] === 0x70
	)
		return "video/mp4";
	if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
		return "audio/mpeg";
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46
	)
		return "audio/wav";
	if (
		bytes[0] === 0x4f &&
		bytes[1] === 0x67 &&
		bytes[2] === 0x67 &&
		bytes[3] === 0x53
	)
		return "audio/ogg";
	return "application/octet-stream";
}

export function classifyAssetKind(mimeType: string): AssetKind {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	if (
		mimeType === "application/pdf" ||
		mimeType.startsWith("text/") ||
		mimeType.includes("document") ||
		mimeType.includes("officedocument")
	) {
		return "document";
	}
	return "other";
}

export function parseJsonField<T>(
	raw: FormDataEntryValue | null,
	field: string,
	fallback: T,
): T {
	if (raw == null) return fallback;
	if (typeof raw !== "string") {
		throw new Error(`${field} must be a JSON string`);
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`${field} must be valid JSON`);
	}
}

export function parseBooleanField(
	raw: FormDataEntryValue | null,
	fallback: boolean,
): boolean {
	if (raw == null) return fallback;
	if (typeof raw !== "string") return fallback;
	return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function parseNumberField(
	raw: FormDataEntryValue | null,
	field: string,
): number | null {
	if (raw == null) return null;
	if (typeof raw !== "string") {
		throw new Error(`${field} must be a number`);
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${field} must be a number`);
	}
	return parsed;
}

export function validateFocalPoint(value: unknown): FocalPoint | null {
	if (value == null) return null;
	if (typeof value !== "object") {
		throw new Error("focalPoint must be an object");
	}
	const point = value as Record<string, unknown>;
	const x = Number(point.x);
	const y = Number(point.y);
	if (
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		x < 0 ||
		x > 1 ||
		y < 0 ||
		y > 1
	) {
		throw new Error(
			"focalPoint.x and focalPoint.y must be numbers between 0 and 1",
		);
	}
	return { x, y };
}

export function validateThumbnailRequests(value: unknown): ThumbnailRequest[] {
	if (value == null) return [];
	if (!Array.isArray(value)) {
		throw new Error("thumbnails must be an array");
	}
	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`thumbnails[${index}] must be an object`);
		}
		const item = entry as Record<string, unknown>;
		const name = String(item.name ?? "").trim();
		const width = Number(item.width);
		const height = Number(item.height);
		const fit = item.fit === "cover" ? "cover" : "inside";
		const format = item.format;
		const quality = item.quality == null ? undefined : Number(item.quality);
		if (!name) throw new Error(`thumbnails[${index}].name is required`);
		if (!Number.isInteger(width) || width <= 0)
			throw new Error(`thumbnails[${index}].width must be a positive integer`);
		if (!Number.isInteger(height) || height <= 0)
			throw new Error(`thumbnails[${index}].height must be a positive integer`);
		if (!["jpeg", "png", "webp", "avif"].includes(String(format))) {
			throw new Error(
				`thumbnails[${index}].format must be jpeg, png, webp, or avif`,
			);
		}
		if (
			quality != null &&
			(!Number.isFinite(quality) || quality < 1 || quality > 100)
		) {
			throw new Error(`thumbnails[${index}].quality must be between 1 and 100`);
		}
		return {
			name,
			width,
			height,
			fit,
			format: format as ThumbnailRequest["format"],
			quality,
		};
	});
}

export function parseJsonQuery(
	requestUrl: URL,
	key: string,
): Record<string, unknown> | null {
	const raw = requestUrl.searchParams.get(key);
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error();
		}
		return value;
	} catch {
		throw new Error(`${key} must be a JSON object`);
	}
}

export function buildSearchText(
	search: string | null,
	metadata: Record<string, unknown>,
	fallbackName: string,
): string {
	const fragments = [search ?? "", fallbackName];
	for (const [key, value] of Object.entries(metadata)) {
		fragments.push(
			key,
			typeof value === "string" ? value : JSON.stringify(value),
		);
	}
	return fragments.filter(Boolean).join(" ").trim();
}

export function withContentDisposition(filename: string): string {
	return `inline; filename="${filename.replace(/"/g, "")}"`;
}

export function nowIso(): string {
	return new Date().toISOString();
}
