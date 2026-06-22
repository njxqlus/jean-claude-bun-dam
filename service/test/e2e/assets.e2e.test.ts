import { afterEach, beforeAll, describe, expect, test } from "bun:test";

const runE2E = Bun.env.RUN_E2E === "1";
const describeE2E = runE2E ? describe : describe.skip;
const baseUrl = (Bun.env.TEST_BASE_URL ?? "http://localhost:3000").replace(
	/\/$/,
	"",
);
const runId = `e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const createdAssetIds = new Set<string>();

const tinyGifBytes = Uint8Array.from(
	atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
	(char) => char.charCodeAt(0),
);

type AssetResponse = {
	id: string;
	kind: string;
	status: string;
	mime_type: string;
	original_filename: string;
	normalized_name: string;
	metadata: Record<string, unknown>;
	typed_metadata: Record<string, unknown>;
	derivatives: Array<{
		name: string;
		mime_type: string;
		size: number;
		metadata: Record<string, unknown>;
	}>;
};

async function sleep(ms: number) {
	await Bun.sleep(ms);
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

async function waitForService() {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			const response = await fetch(`${baseUrl}/assets`);
			if (response.ok) {
				return;
			}
			lastError = new Error(`Unexpected status ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(1000);
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Service is unavailable");
}

async function createAsset(fields: {
	file: File;
	metadata?: Record<string, unknown>;
	search?: string;
	temporary?: boolean;
	ttlSeconds?: number;
	thumbnails?: unknown[];
}) {
	const formData = new FormData();
	formData.set("file", fields.file);
	formData.set("metadata", JSON.stringify(fields.metadata ?? {}));
	if (fields.search) {
		formData.set("search", fields.search);
	}
	if (fields.temporary != null) {
		formData.set("temporary", String(fields.temporary));
	}
	if (fields.ttlSeconds != null) {
		formData.set("ttlSeconds", String(fields.ttlSeconds));
	}
	if (fields.thumbnails) {
		formData.set("thumbnails", JSON.stringify(fields.thumbnails));
	}

	const response = await fetch(`${baseUrl}/assets`, {
		method: "POST",
		body: formData,
	});
	return response;
}

async function getAsset(assetId: string) {
	return await fetch(`${baseUrl}/assets/${assetId}`);
}

async function finalizeAsset(assetId: string) {
	return await fetch(`${baseUrl}/assets/${assetId}`, {
		method: "POST",
	});
}

async function deleteAsset(assetId: string) {
	return await fetch(`${baseUrl}/assets/${assetId}`, {
		method: "DELETE",
	});
}

async function waitForAsset(
	assetId: string,
	assertion: (asset: AssetResponse) => boolean,
	timeoutMs: number,
) {
	const deadline = Date.now() + timeoutMs;
	let lastAsset: AssetResponse | null = null;

	while (Date.now() < deadline) {
		const response = await getAsset(assetId);
		if (response.status === 200) {
			lastAsset = await json<AssetResponse>(response);
			if (assertion(lastAsset)) {
				return lastAsset;
			}
		}
		await sleep(500);
	}

	throw new Error(
		`Timed out waiting for asset state: ${JSON.stringify(lastAsset, null, 2)}`,
	);
}

beforeAll(async () => {
	if (!runE2E) {
		return;
	}
	await waitForService();
});

afterEach(async () => {
	if (!runE2E) {
		return;
	}
	for (const assetId of createdAssetIds) {
		await deleteAsset(assetId);
	}
	createdAssetIds.clear();
});

describeE2E("real infrastructure asset endpoints", () => {
	test("creates, lists, serves, and deletes a text asset", async () => {
		const marker = `${runId}-text`;
		const createResponse = await createAsset({
			file: new File(["hello e2e"], "Greeting.TXT", { type: "text/plain" }),
			search: marker,
			metadata: { suite: runId, case: "text" },
		});

		expect(createResponse.status).toBe(201);
		const created = await json<AssetResponse>(createResponse);
		createdAssetIds.add(created.id);
		expect(created.original_filename).toBe("Greeting.TXT");
		expect(created.normalized_name).toBe("greeting.txt");
		expect(created.kind).toBe("other");

		const getResponse = await getAsset(created.id);
		expect(getResponse.status).toBe(200);
		const fetched = await json<AssetResponse>(getResponse);
		expect(fetched.metadata).toEqual({ suite: runId, case: "text" });

		const fileResponse = await fetch(`${baseUrl}/assets/${created.id}/file`);
		expect(fileResponse.status).toBe(200);
		expect(fileResponse.headers.get("content-type")).toBe(created.mime_type);
		expect(await fileResponse.text()).toBe("hello e2e");

		const listResponse = await fetch(
			`${baseUrl}/assets?metadata=${encodeURIComponent(
				JSON.stringify({ suite: runId, case: "text" }),
			)}`,
		);
		expect(listResponse.status).toBe(200);
		const listed = await json<{
			data: AssetResponse[];
			pagination: { total: number };
		}>(listResponse);
		expect(listed.pagination.total).toBeGreaterThanOrEqual(1);
		expect(listed.data.some((asset) => asset.id === created.id)).toBe(true);

		const deleteResponse = await deleteAsset(created.id);
		expect(deleteResponse.status).toBe(200);
		expect(
			await json<{ deleted: boolean; id: string }>(deleteResponse),
		).toEqual({
			deleted: true,
			id: created.id,
		});
		createdAssetIds.delete(created.id);

		const missingResponse = await getAsset(created.id);
		expect(missingResponse.status).toBe(404);
	}, 15000);

	test("generates and serves a thumbnail through the worker", async () => {
		const createResponse = await createAsset({
			file: new File([tinyGifBytes], "pixel.gif", { type: "image/gif" }),
			metadata: { suite: runId, case: "thumbnail" },
			thumbnails: [
				{
					name: "thumb",
					width: 32,
					height: 32,
					fit: "inside",
					format: "webp",
					quality: 80,
				},
			],
		});

		expect(createResponse.status).toBe(201);
		const created = await json<AssetResponse>(createResponse);
		createdAssetIds.add(created.id);
		expect(created.kind).toBe("image");
		expect(created.status).toBe("processing");

		const ready = await waitForAsset(
			created.id,
			(asset) =>
				asset.status === "ready" &&
				asset.derivatives.some((derivative) => derivative.name === "thumb"),
			15000,
		);
		const derivative = ready.derivatives.find(
			(entry) => entry.name === "thumb",
		);
		expect(derivative).toBeDefined();
		expect(derivative?.mime_type).toBe("image/webp");

		const derivativeResponse = await fetch(
			`${baseUrl}/assets/${created.id}/derivatives/thumb`,
		);
		expect(derivativeResponse.status).toBe(200);
		expect(derivativeResponse.headers.get("content-type")).toBe("image/webp");
		expect((await derivativeResponse.arrayBuffer()).byteLength).toBeGreaterThan(
			0,
		);
	}, 20000);

	test("returns upload validation errors", async () => {
		const response = await createAsset({
			file: new File(["bad request"], "invalid.txt", { type: "text/plain" }),
			temporary: true,
		});

		expect(response.status).toBe(400);
		expect(
			await json<{
				error: { message: string; details: null };
			}>(response),
		).toEqual({
			error: {
				message: "temporary uploads require ttlSeconds > 0",
				details: null,
			},
		});
	});

	test("cleans up expired temporary assets", async () => {
		const createResponse = await createAsset({
			file: new File(["expire me"], "expired.txt", { type: "text/plain" }),
			metadata: { suite: runId, case: "cleanup" },
			temporary: true,
			ttlSeconds: 1,
		});

		expect(createResponse.status).toBe(201);
		const created = await json<AssetResponse>(createResponse);
		createdAssetIds.add(created.id);

		await sleep(1500);

		const cleanupResponse = await fetch(`${baseUrl}/internal/cleanup-expired`, {
			method: "POST",
		});
		expect(cleanupResponse.status).toBe(200);
		const cleanup = await json<{
			deletedAssets: number;
			deletedDerivatives: number;
			checkedAt: string;
		}>(cleanupResponse);
		expect(cleanup.deletedAssets).toBeGreaterThanOrEqual(1);
		expect(cleanup.deletedDerivatives).toBeGreaterThanOrEqual(0);

		const missingResponse = await getAsset(created.id);
		expect(missingResponse.status).toBe(404);
		createdAssetIds.delete(created.id);
	}, 15000);

	test("finalizes a temporary asset server-side", async () => {
		const createResponse = await createAsset({
			file: new File(["keep me"], "temporary.txt", { type: "text/plain" }),
			metadata: { suite: runId, case: "finalize" },
			temporary: true,
			ttlSeconds: 3600,
		});

		expect(createResponse.status).toBe(201);
		const created = await json<AssetResponse & { expires_at: string | null }>(
			createResponse,
		);
		createdAssetIds.add(created.id);
		expect(created.expires_at).not.toBeNull();

		const finalizeResponse = await finalizeAsset(created.id);
		expect(finalizeResponse.status).toBe(200);
		const finalized = await json<AssetResponse & { expires_at: string | null }>(
			finalizeResponse,
		);
		expect(finalized.expires_at).toBeNull();
	}, 15000);
});
