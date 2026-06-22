import { beforeEach, describe, expect, test } from "bun:test";
import { createFetchHandler } from "./app";
import type { AppConfig } from "./config";
import type { AssetRepository } from "./db";
import { AssetService } from "./service";
import type { StorageAdapter } from "./storage";
import type {
	AssetRecord,
	AssetWithDerivatives,
	CreateAssetInput,
	CreateDerivativeInput,
	DerivativeRecord,
	JobRecord,
	JobType,
} from "./types";

class InMemoryStorageAdapter implements StorageAdapter {
	readonly name = "memory";
	readonly objects = new Map<
		string,
		{ body: Uint8Array; contentType: string; size: number }
	>();

	async put(key: string, body: Blob, contentType: string) {
		const bytes = new Uint8Array(await body.arrayBuffer());
		this.objects.set(key, {
			body: bytes,
			contentType,
			size: bytes.byteLength,
		});
		return { key, size: bytes.byteLength, contentType };
	}

	async get(key: string) {
		const object = this.objects.get(key);
		if (!object) {
			throw new Error(`Object not found: ${key}`);
		}
		const bytes = object.body.buffer.slice(
			object.body.byteOffset,
			object.body.byteOffset + object.body.byteLength,
		) as ArrayBuffer;
		return {
			body: new Blob([bytes], { type: object.contentType }).stream(),
			contentType: object.contentType,
			size: object.size,
		};
	}

	async delete(key: string) {
		this.objects.delete(key);
	}
}

class InMemoryAssetRepository implements AssetRepository {
	readonly assets = new Map<string, AssetRecord>();
	readonly derivatives = new Map<string, DerivativeRecord[]>();
	readonly jobs = new Map<string, JobRecord>();
	healthy = true;

	async connect() {}

	async close() {}

	async ping() {
		if (!this.healthy) {
			throw new Error("database unavailable");
		}
	}

	async migrate() {}

	async insertAsset(input: CreateAssetInput) {
		const asset: AssetRecord = {
			id: input.id,
			original_filename: input.originalFilename,
			normalized_name: input.normalizedName,
			mime_type: input.mimeType,
			size: input.size,
			checksum: input.checksum,
			storage_adapter: input.storageAdapter,
			storage_key: input.storageKey,
			kind: input.kind,
			status: input.status,
			search_text: input.searchText,
			metadata: input.metadata,
			typed_metadata: input.typedMetadata,
			created_at: new Date().toISOString(),
			expires_at: input.expiresAt,
			error: input.error,
		};
		this.assets.set(asset.id, asset);
		return asset;
	}

	async updateAssetStatus(
		assetId: string,
		status: string,
		error: string | null,
	) {
		const existing = this.assets.get(assetId);
		if (!existing) return null;
		const updated: AssetRecord = {
			...existing,
			status: status as AssetRecord["status"],
			error,
		};
		this.assets.set(assetId, updated);
		return updated;
	}

	async clearAssetExpiry(assetId: string) {
		const existing = this.assets.get(assetId);
		if (!existing) return null;
		const updated: AssetRecord = {
			...existing,
			expires_at: null,
		};
		this.assets.set(assetId, updated);
		return updated;
	}

	async getAssetById(assetId: string) {
		const asset = this.assets.get(assetId);
		if (!asset) return null;
		return {
			...asset,
			derivatives: [...(this.derivatives.get(assetId) ?? [])],
		};
	}

	async insertDerivative(input: CreateDerivativeInput) {
		const derivative: DerivativeRecord = {
			id: crypto.randomUUID(),
			asset_id: input.assetId,
			name: input.name,
			storage_adapter: input.storageAdapter,
			storage_key: input.storageKey,
			mime_type: input.mimeType,
			size: input.size,
			metadata: input.metadata,
			created_at: new Date().toISOString(),
		};
		const existing = this.derivatives.get(input.assetId) ?? [];
		const next = existing.filter((entry) => entry.name !== input.name);
		next.push(derivative);
		this.derivatives.set(input.assetId, next);
		return derivative;
	}

	async getDerivative(assetId: string, name: string) {
		return (
			this.derivatives.get(assetId)?.find((entry) => entry.name === name) ??
			null
		);
	}

	async deleteAsset(assetId: string) {
		const asset = this.assets.get(assetId) ?? null;
		const derivatives = this.derivatives.get(assetId) ?? [];
		this.assets.delete(assetId);
		this.derivatives.delete(assetId);
		for (const [jobId, job] of this.jobs.entries()) {
			if (job.payload.assetId === assetId) {
				this.jobs.delete(jobId);
			}
		}
		return { asset, derivatives };
	}

	async listAssets(filters: {
		limit: number;
		offset: number;
		sortBy: string;
		sortDirection: "asc" | "desc";
		kind: string | null;
		mimeType: string | null;
		status: string | null;
		search: string | null;
		createdAtFrom: string | null;
		createdAtTo: string | null;
		expiresAtFrom: string | null;
		expiresAtTo: string | null;
		metadata: Record<string, unknown> | null;
		typedMetadata: Record<string, unknown> | null;
	}) {
		const rows = [...this.assets.values()].filter((asset) => {
			if (filters.kind && asset.kind !== filters.kind) return false;
			if (filters.mimeType && asset.mime_type !== filters.mimeType)
				return false;
			if (filters.status && asset.status !== filters.status) return false;
			if (
				filters.search &&
				!`${asset.search_text ?? ""} ${asset.original_filename} ${asset.normalized_name}`
					.toLowerCase()
					.includes(filters.search.toLowerCase())
			) {
				return false;
			}
			if (filters.metadata) {
				for (const [key, value] of Object.entries(filters.metadata)) {
					if (asset.metadata[key] !== value) return false;
				}
			}
			if (filters.typedMetadata) {
				for (const [key, value] of Object.entries(filters.typedMetadata)) {
					if (asset.typed_metadata[key] !== value) return false;
				}
			}
			return true;
		});

		rows.sort((left, right) => {
			const factor = filters.sortDirection === "asc" ? 1 : -1;
			const leftValue = String(left.created_at);
			const rightValue = String(right.created_at);
			return leftValue.localeCompare(rightValue) * factor;
		});

		const paged = rows.slice(filters.offset, filters.offset + filters.limit);
		return {
			total: rows.length,
			rows: paged.map<AssetWithDerivatives>((asset) => ({
				...asset,
				derivatives: [...(this.derivatives.get(asset.id) ?? [])],
			})),
		};
	}

	async enqueueJob(
		type: JobType,
		payload: Record<string, unknown>,
		options?: { maxAttempts?: number; runAfter?: string },
	) {
		const job: JobRecord = {
			id: crypto.randomUUID(),
			type,
			status: "pending",
			payload,
			attempts: 0,
			max_attempts: options?.maxAttempts ?? 5,
			run_after: options?.runAfter ?? new Date().toISOString(),
			locked_at: null,
			locked_by: null,
			error: null,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		this.jobs.set(job.id, job);
		return job;
	}

	async claimNextJob() {
		const staleBefore = Date.now() - 5 * 60 * 1000;
		const job = [...this.jobs.values()]
			.filter(
				(entry) =>
					["pending", "running", "failed"].includes(entry.status) &&
					entry.attempts < entry.max_attempts &&
					Date.parse(entry.run_after) <= Date.now() &&
					(entry.locked_at === null ||
						Date.parse(entry.locked_at) < staleBefore),
			)
			.sort((left, right) => {
				const runAfterDiff =
					Date.parse(left.run_after) - Date.parse(right.run_after);
				if (runAfterDiff !== 0) return runAfterDiff;
				return Date.parse(left.created_at) - Date.parse(right.created_at);
			})[0];
		if (!job) return null;

		const claimed: JobRecord = {
			...job,
			status: "running",
			attempts: job.attempts + 1,
			locked_at: new Date().toISOString(),
			locked_by: "test-worker",
			updated_at: new Date().toISOString(),
			error: null,
		};
		this.jobs.set(claimed.id, claimed);
		return claimed;
	}

	async completeJob() {}

	async failJob() {}

	async countPendingThumbnailJobs(assetId: string) {
		return [...this.jobs.values()].filter(
			(job) =>
				job.type === "thumbnail.generate" &&
				job.payload.assetId === assetId &&
				job.attempts < job.max_attempts &&
				["pending", "running", "failed"].includes(job.status),
		).length;
	}

	async listExpiredAssetRows(limit = 100) {
		const now = Date.now();
		return [...this.assets.values()]
			.filter(
				(asset) => asset.expires_at && Date.parse(asset.expires_at) <= now,
			)
			.slice(0, limit);
	}
}

const testConfig: AppConfig = {
	appEnv: "test",
	port: 3000,
	databaseUrl: "postgres://unused",
	s3Endpoint: "http://unused",
	s3Region: "us-east-1",
	s3Bucket: "test-bucket",
	s3AccessKeyId: "test",
	s3SecretAccessKey: "test",
	s3PathStyle: true,
	s3Prefix: "assets",
	maxUploadBytes: 1024 * 1024,
	cleanupIntervalSeconds: 300,
	workerPollIntervalMs: 1000,
	workerId: "test-worker",
};

function createTestContext() {
	const db = new InMemoryAssetRepository();
	const storage = new InMemoryStorageAdapter();
	const service = new AssetService(testConfig, db, storage);
	return {
		db,
		storage,
		fetch: createFetchHandler(service),
	};
}

describe("job claiming", () => {
	test("reclaims stale running jobs", async () => {
		const repo = new InMemoryAssetRepository();
		const staleLockedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
		const job = await repo.enqueueJob(
			"thumbnail.generate",
			{ assetId: "asset-1", derivativeName: "thumb" },
			{ runAfter: new Date(Date.now() - 1000).toISOString() },
		);
		repo.jobs.set(job.id, {
			...job,
			status: "running",
			attempts: 1,
			locked_at: staleLockedAt,
			locked_by: "dead-worker",
		});

		const claimed = await repo.claimNextJob();

		expect(claimed).not.toBeNull();
		expect(claimed?.id).toBe(job.id);
		expect(claimed?.status).toBe("running");
		expect(claimed?.attempts).toBe(2);
		expect(claimed?.locked_by).toBe("test-worker");
	});
});

async function createAssetRequest(fields?: {
	search?: string;
	metadata?: Record<string, unknown>;
	temporary?: boolean;
	ttlSeconds?: number;
}) {
	const formData = new FormData();
	formData.set(
		"file",
		new File(["hello integration"], "Greeting.TXT", { type: "text/plain" }),
	);
	if (fields?.search) {
		formData.set("search", fields.search);
	}
	if (fields?.metadata) {
		formData.set("metadata", JSON.stringify(fields.metadata));
	}
	if (fields?.temporary != null) {
		formData.set("temporary", String(fields.temporary));
	}
	if (fields?.ttlSeconds != null) {
		formData.set("ttlSeconds", String(fields.ttlSeconds));
	}
	return new Request("http://test/assets", {
		method: "POST",
		body: formData,
	});
}

describe("asset endpoints", () => {
	let context: ReturnType<typeof createTestContext>;

	beforeEach(() => {
		context = createTestContext();
	});

	test("creates an asset and serves its original file", async () => {
		const createResponse = await context.fetch(
			await createAssetRequest({
				search: "alpha",
				metadata: { project: "alpha" },
			}),
		);

		expect(createResponse.status).toBe(201);
		const created = (await createResponse.json()) as AssetWithDerivatives;
		expect(created.original_filename).toBe("Greeting.TXT");
		expect(created.normalized_name).toBe("greeting.txt");
		expect(created.kind).toBe("other");
		expect(context.storage.objects.has(created.storage_key)).toBe(true);

		const getResponse = await context.fetch(
			new Request(`http://test/assets/${created.id}`),
		);
		expect(getResponse.status).toBe(200);
		const fetched = (await getResponse.json()) as AssetWithDerivatives;
		expect(fetched.id).toBe(created.id);
		expect(fetched.metadata).toEqual({ project: "alpha" });

		const fileResponse = await context.fetch(
			new Request(`http://test/assets/${created.id}/file`),
		);
		expect(fileResponse.status).toBe(200);
		expect(fileResponse.headers.get("content-type")).toBe(created.mime_type);
		expect(fileResponse.headers.get("content-length")).toBe("17");
		expect(await fileResponse.text()).toBe("hello integration");
	});

	test("serves health and readiness endpoints", async () => {
		const healthResponse = await context.fetch(
			new Request("http://test/healthz"),
		);
		expect(healthResponse.status).toBe(200);
		expect(await healthResponse.json()).toEqual({ ok: true });

		const readyResponse = await context.fetch(
			new Request("http://test/readyz"),
		);
		expect(readyResponse.status).toBe(200);
		expect(await readyResponse.json()).toEqual({ ok: true });

		context.db.healthy = false;
		const failedReadyResponse = await context.fetch(
			new Request("http://test/readyz"),
		);
		expect(failedReadyResponse.status).toBe(400);
		expect(await failedReadyResponse.json()).toEqual({
			error: {
				message: "database unavailable",
				details: null,
			},
		});
	});

	test("lists assets with endpoint filters and deletes them through the API", async () => {
		const first = await context.fetch(
			await createAssetRequest({
				search: "alpha",
				metadata: { project: "alpha" },
			}),
		);
		const second = await context.fetch(
			await createAssetRequest({
				search: "beta",
				metadata: { project: "beta" },
			}),
		);
		const createdFirst = (await first.json()) as AssetWithDerivatives;
		await second.json();

		const listResponse = await context.fetch(
			new Request(
				"http://test/assets?search=alpha&metadata=%7B%22project%22%3A%22alpha%22%7D",
			),
		);
		expect(listResponse.status).toBe(200);
		const listed = (await listResponse.json()) as {
			data: AssetWithDerivatives[];
			pagination: { total: number };
		};
		expect(listed.pagination.total).toBe(1);
		expect(listed.data).toHaveLength(1);
		expect(listed.data[0]?.id).toBe(createdFirst.id);

		const deleteResponse = await context.fetch(
			new Request(`http://test/assets/${createdFirst.id}`, {
				method: "DELETE",
			}),
		);
		expect(deleteResponse.status).toBe(200);
		expect(await deleteResponse.json()).toEqual({
			deleted: true,
			id: createdFirst.id,
		});

		const missingResponse = await context.fetch(
			new Request(`http://test/assets/${createdFirst.id}`),
		);
		expect(missingResponse.status).toBe(404);
	});

	test("finalizes a temporary asset through the API", async () => {
		const createResponse = await context.fetch(
			await createAssetRequest({
				temporary: true,
				ttlSeconds: 3600,
			}),
		);
		const created = (await createResponse.json()) as AssetWithDerivatives;
		expect(created.expires_at).not.toBeNull();

		const finalizeResponse = await context.fetch(
			new Request(`http://test/assets/${created.id}`, {
				method: "POST",
			}),
		);
		expect(finalizeResponse.status).toBe(200);
		const finalized = (await finalizeResponse.json()) as AssetWithDerivatives;
		expect(finalized.id).toBe(created.id);
		expect(finalized.expires_at).toBeNull();
	});

	test("rejects finalizing a non-temporary asset", async () => {
		const createResponse = await context.fetch(await createAssetRequest());
		const created = (await createResponse.json()) as AssetWithDerivatives;

		const finalizeResponse = await context.fetch(
			new Request(`http://test/assets/${created.id}`, {
				method: "POST",
			}),
		);
		expect(finalizeResponse.status).toBe(400);
		expect(await finalizeResponse.json()).toEqual({
			error: {
				message: "Asset is not temporary",
				details: null,
			},
		});
	});

	test("serves derivative files for an existing asset", async () => {
		const createdResponse = await context.fetch(await createAssetRequest());
		const created = (await createdResponse.json()) as AssetWithDerivatives;
		await context.db.insertDerivative({
			assetId: created.id,
			name: "thumb",
			storageAdapter: context.storage.name,
			storageKey: `assets/${created.id}/derivatives/thumb.webp`,
			mimeType: "image/webp",
			size: 15,
			metadata: {
				width: 64,
				height: 64,
				format: "webp",
				fit: "inside",
				focalPoint: null,
			},
		});
		await context.storage.put(
			`assets/${created.id}/derivatives/thumb.webp`,
			new Blob(["derivative-bytes"], { type: "image/webp" }),
			"image/webp",
		);

		const response = await context.fetch(
			new Request(`http://test/assets/${created.id}/derivatives/thumb`),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/webp");
		expect(response.headers.get("content-length")).toBe("15");
		expect(await response.text()).toBe("derivative-bytes");
	});

	test("returns validation errors from the upload endpoint", async () => {
		const response = await context.fetch(
			await createAssetRequest({
				temporary: true,
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				message: "temporary uploads require ttlSeconds > 0",
				details: null,
			},
		});
	});

	test("cleans up expired assets through the internal endpoint", async () => {
		const expired = await context.db.insertAsset({
			id: crypto.randomUUID(),
			originalFilename: "expired.txt",
			normalizedName: "expired.txt",
			mimeType: "text/plain",
			size: 7,
			checksum: "checksum",
			storageAdapter: context.storage.name,
			storageKey: "assets/expired.txt",
			kind: "other",
			status: "ready",
			searchText: "expired",
			metadata: {},
			typedMetadata: {},
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			error: null,
		});
		await context.storage.put(
			expired.storage_key,
			new Blob(["expired"], { type: "text/plain" }),
			"text/plain",
		);

		const response = await context.fetch(
			new Request("http://test/internal/cleanup-expired", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			deletedAssets: number;
			deletedDerivatives: number;
			checkedAt: string;
		};
		expect(result.deletedAssets).toBe(1);
		expect(result.deletedDerivatives).toBe(0);
		expect(context.db.assets.has(expired.id)).toBe(false);
		expect(context.storage.objects.has(expired.storage_key)).toBe(false);
		expect(Date.parse(result.checkedAt)).not.toBeNaN();
	});
});
