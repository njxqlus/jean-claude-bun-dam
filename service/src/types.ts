export type AssetKind = "image" | "audio" | "video" | "document" | "other";
export type AssetStatus = "processing" | "ready" | "failed" | "expired";
export type JobStatus = "pending" | "running" | "completed" | "failed";

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

export type AssetListResult = {
	data: AssetWithDerivatives[];
	pagination: {
		limit: number;
		offset: number;
		total: number;
	};
};

export type AssetWithDerivatives = AssetRecord & {
	derivatives: DerivativeRecord[];
};

export type CreateAssetInput = {
	id: string;
	originalFilename: string;
	normalizedName: string;
	mimeType: string;
	size: number;
	checksum: string;
	storageAdapter: string;
	storageKey: string;
	kind: AssetKind;
	status: AssetStatus;
	searchText: string | null;
	metadata: Record<string, unknown>;
	typedMetadata: Record<string, unknown>;
	expiresAt: string | null;
	error: string | null;
};

export type CreateDerivativeInput = {
	assetId: string;
	name: string;
	storageAdapter: string;
	storageKey: string;
	mimeType: string;
	size: number;
	metadata: Record<string, unknown>;
};

export type JobType = "thumbnail.generate" | "cleanup.expired";

export type JobRecord = {
	id: string;
	type: JobType;
	status: JobStatus;
	payload: Record<string, unknown>;
	attempts: number;
	max_attempts: number;
	run_after: string;
	locked_at: string | null;
	locked_by: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
};

export type ThumbnailJobPayload = {
	assetId: string;
	derivativeName: string;
	request: ThumbnailRequest;
	focalPoint: FocalPoint | null;
};
