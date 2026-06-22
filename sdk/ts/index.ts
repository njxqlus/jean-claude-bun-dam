export type AssetKind = "image" | "audio" | "video" | "document" | "other";
export type AssetStatus = "processing" | "ready" | "failed" | "expired";
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type FocalPoint = {
	x: number;
	y: number;
};
export type ThumbnailRequest = {
	name: string;
	width: number;
	height: number;
	fit: "cover" | "inside";
	format: "jpeg" | "png" | "webp" | "avif";
	quality?: number;
};
export type AssetRecord = {
	id: string;
	original_filename: string;
	normalized_name: string;
	mime_type: string;
	size: number;
	checksum: string;
	storage_adapter: string;
	storage_key: string;
	kind: AssetKind;
	status: AssetStatus;
	search_text: string | null;
	metadata: Record<string, unknown>;
	typed_metadata: Record<string, unknown>;
	created_at: string;
	expires_at: string | null;
	error: string | null;
};
export type DerivativeRecord = {
	id: string;
	asset_id: string;
	name: string;
	storage_adapter: string;
	storage_key: string;
	mime_type: string;
	size: number;
	metadata: Record<string, unknown>;
	created_at: string;
};
export type Asset = AssetRecord & {
	derivatives: DerivativeRecord[];
};
export type AssetListResult = {
	data: Asset[];
	pagination: {
		limit: number;
		offset: number;
		total: number;
	};
};
export type DeleteAssetResult = {
	deleted: true;
	id: string;
};
export type CleanupExpiredResult = {
	deletedAssets: number;
	deletedDerivatives: number;
	checkedAt: string;
};
export type ListAssetsParams = {
	limit?: number;
	offset?: number;
	sortBy?:
		| "created_at"
		| "expires_at"
		| "mime_type"
		| "kind"
		| "status"
		| "size";
	sortDirection?: "asc" | "desc";
	kind?: AssetKind;
	mimeType?: string;
	status?: AssetStatus;
	createdAtFrom?: string;
	createdAtTo?: string;
	expiresAtFrom?: string;
	expiresAtTo?: string;
	search?: string;
	metadata?: JsonObject;
	typedMetadata?: JsonObject;
};
export type CreateAssetParams = {
	file: Blob;
	filename?: string;
	metadata?: JsonObject;
	search?: string;
	temporary?: boolean;
	ttlSeconds?: number;
	focalPoint?: FocalPoint;
	thumbnails?: ThumbnailRequest[];
};
export type DownloadResult = {
	response: Response;
	contentType: string | null;
	contentLength: number | null;
	fileName: string | null;
	checksumSha256: string | null;
	blob(): Promise<Blob>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
};
export type JeanClaudeBunDamClientOptions = {
	baseUrl?: string;
	envKey?: string;
	fetch?: typeof fetch;
	headers?: HeadersInit;
};
export type JeanClaudeBunDamErrorPayload = {
	error?: {
		message?: string;
		details?: unknown;
	};
};

const DEFAULT_ENV_KEY = "JEAN_CLAUDE_BUN_DAM_SERVER_URL";

export class JeanClaudeBunDamError extends Error {
	readonly status: number;
	readonly details: unknown;
	readonly response: Response;

	constructor(
		message: string,
		status: number,
		details: unknown,
		response: Response,
	) {
		super(message);
		this.name = "JeanClaudeBunDamError";
		this.status = status;
		this.details = details;
		this.response = response;
	}
}

export class JeanClaudeBunDamClient {
	readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly defaultHeaders: HeadersInit | undefined;

	constructor(options: JeanClaudeBunDamClientOptions = {}) {
		this.baseUrl = resolveBaseUrl(options.baseUrl, options.envKey);
		this.fetchImpl = options.fetch ?? fetch;
		this.defaultHeaders = options.headers;
	}

	/**
	 * Creates an asset with optional metadata, TTL, focal point, and thumbnail jobs.
	 */
	async createAsset(params: CreateAssetParams): Promise<Asset> {
		const formData = new FormData();
		formData.set("file", toFile(params.file, params.filename));
		formData.set("metadata", JSON.stringify(params.metadata ?? {}));
		if (params.search != null) formData.set("search", params.search);
		if (params.temporary != null) {
			formData.set("temporary", String(params.temporary));
		}
		if (params.ttlSeconds != null) {
			formData.set("ttlSeconds", String(params.ttlSeconds));
		}
		if (params.focalPoint != null) {
			formData.set("focalPoint", JSON.stringify(params.focalPoint));
		}
		if (params.thumbnails != null && params.thumbnails.length > 0) {
			formData.set("thumbnails", JSON.stringify(params.thumbnails));
		}
		return this.requestJson<Asset>("/assets", {
			method: "POST",
			body: formData,
		});
	}

	/**
	 * Lists assets with pagination, sorting, and JSON filter support.
	 */
	async listAssets(params: ListAssetsParams = {}): Promise<AssetListResult> {
		const searchParams = new URLSearchParams();
		setSearchParam(searchParams, "limit", params.limit);
		setSearchParam(searchParams, "offset", params.offset);
		setSearchParam(searchParams, "sortBy", params.sortBy);
		setSearchParam(searchParams, "sortDirection", params.sortDirection);
		setSearchParam(searchParams, "kind", params.kind);
		setSearchParam(searchParams, "mimeType", params.mimeType);
		setSearchParam(searchParams, "status", params.status);
		setSearchParam(searchParams, "createdAtFrom", params.createdAtFrom);
		setSearchParam(searchParams, "createdAtTo", params.createdAtTo);
		setSearchParam(searchParams, "expiresAtFrom", params.expiresAtFrom);
		setSearchParam(searchParams, "expiresAtTo", params.expiresAtTo);
		setSearchParam(searchParams, "search", params.search);
		setJsonSearchParam(searchParams, "metadata", params.metadata);
		setJsonSearchParam(searchParams, "typedMetadata", params.typedMetadata);
		const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
		return this.requestJson<AssetListResult>(`/assets${suffix}`);
	}

	/**
	 * Returns one asset with its derivative records.
	 */
	async getAsset(id: string): Promise<Asset> {
		return this.requestJson<Asset>(`/assets/${encodeSegment(id)}`);
	}

	/**
	 * Streams the original asset file through the service.
	 */
	async getAssetFile(id: string): Promise<DownloadResult> {
		return this.requestDownload(`/assets/${encodeSegment(id)}/file`);
	}

	/**
	 * Streams a named derivative through the service.
	 */
	async getAssetDerivative(id: string, name: string): Promise<DownloadResult> {
		return this.requestDownload(
			`/assets/${encodeSegment(id)}/derivatives/${encodeSegment(name)}`,
		);
	}

	/**
	 * Deletes an asset and all stored derivatives.
	 */
	async deleteAsset(id: string): Promise<DeleteAssetResult> {
		return this.requestJson<DeleteAssetResult>(`/assets/${encodeSegment(id)}`, {
			method: "DELETE",
		});
	}

	/**
	 * Runs the service cleanup endpoint immediately.
	 */
	async cleanupExpired(): Promise<CleanupExpiredResult> {
		return this.requestJson<CleanupExpiredResult>("/internal/cleanup-expired", {
			method: "POST",
		});
	}

	private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await this.request(path, init);
		return (await response.json()) as T;
	}

	private async requestDownload(path: string): Promise<DownloadResult> {
		const response = await this.request(path);
		return {
			response,
			contentType: response.headers.get("content-type"),
			contentLength: parseNullableInteger(
				response.headers.get("content-length"),
			),
			fileName: parseContentDispositionFileName(
				response.headers.get("content-disposition"),
			),
			checksumSha256: response.headers.get("x-checksum-sha256"),
			blob: () => response.clone().blob(),
			arrayBuffer: () => response.clone().arrayBuffer(),
			text: () => response.clone().text(),
		};
	}

	private async request(path: string, init?: RequestInit): Promise<Response> {
		const response = await this.fetchImpl(buildUrl(this.baseUrl, path), {
			...init,
			headers: mergeHeaders(this.defaultHeaders, init?.headers),
		});
		if (!response.ok) {
			throw await toClientError(response);
		}
		return response;
	}
}

export function createClient(
	options: JeanClaudeBunDamClientOptions = {},
): JeanClaudeBunDamClient {
	return new JeanClaudeBunDamClient(options);
}

function resolveBaseUrl(baseUrl?: string, envKey = DEFAULT_ENV_KEY): string {
	const resolved = baseUrl ?? readEnv(envKey);
	if (!resolved) {
		throw new Error(`Missing server URL. Pass { baseUrl } or set ${envKey}.`);
	}
	return resolved.replace(/\/+$/, "");
}

function readEnv(key: string): string | undefined {
	const globalObject = globalThis as {
		process?: { env?: Record<string, string | undefined> };
		Bun?: { env?: Record<string, string | undefined> };
	};
	const processValue =
		typeof globalObject.process?.env?.[key] === "string"
			? globalObject.process.env[key]
			: undefined;
	if (processValue) return processValue;
	const bunValue =
		typeof globalObject.Bun?.env?.[key] === "string"
			? globalObject.Bun.env[key]
			: undefined;
	return bunValue || undefined;
}

function buildUrl(baseUrl: string, path: string): string {
	return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

function setSearchParam(
	searchParams: URLSearchParams,
	key: string,
	value: string | number | boolean | undefined,
) {
	if (value != null) {
		searchParams.set(key, String(value));
	}
}

function setJsonSearchParam(
	searchParams: URLSearchParams,
	key: string,
	value: JsonObject | undefined,
) {
	if (value != null) {
		searchParams.set(key, JSON.stringify(value));
	}
}

function toFile(blob: Blob, filename?: string): File {
	if (blob instanceof File) {
		return blob;
	}
	return new File([blob], filename ?? "upload.bin", {
		type: blob.type || "application/octet-stream",
	});
}

function mergeHeaders(
	defaultHeaders: HeadersInit | undefined,
	requestHeaders: HeadersInit | undefined,
): Headers {
	const headers = new Headers(defaultHeaders);
	if (requestHeaders) {
		new Headers(requestHeaders).forEach((value, key) => {
			headers.set(key, value);
		});
	}
	return headers;
}

function parseNullableInteger(value: string | null): number | null {
	if (value == null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseContentDispositionFileName(value: string | null): string | null {
	if (!value) return null;
	const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8Match?.[1]) {
		return decodeURIComponent(utf8Match[1]);
	}
	const plainMatch = value.match(/filename="([^"]+)"/i);
	if (plainMatch?.[1]) {
		return plainMatch[1];
	}
	return null;
}

async function toClientError(
	response: Response,
): Promise<JeanClaudeBunDamError> {
	const cloned = response.clone();
	let message = `Request failed with status ${response.status}`;
	let details: unknown = null;
	try {
		const payload = (await cloned.json()) as JeanClaudeBunDamErrorPayload;
		if (payload.error?.message) {
			message = payload.error.message;
		}
		details = payload.error?.details ?? payload;
	} catch {
		try {
			const text = await cloned.text();
			if (text) {
				message = text;
				details = text;
			}
		} catch {
			// Keep default message when no structured body can be read.
		}
	}
	return new JeanClaudeBunDamError(message, response.status, details, response);
}
