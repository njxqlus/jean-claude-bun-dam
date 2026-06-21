import { join } from "node:path";
import type { AppConfig } from "./config";
import type { AssetRepository } from "./db";
import { createDerivativeImage, extractImageMetadata } from "./image";
import { S3StorageAdapter, type StorageAdapter } from "./storage";
import type { ThumbnailJobPayload } from "./types";
import {
	buildSearchText,
	classifyAssetKind,
	normalizeFilename,
	nowIso,
	parseBooleanField,
	parseJsonField,
	parseJsonQuery,
	parseNumberField,
	sha256Hex,
	sniffMimeType,
	validateFocalPoint,
	validateThumbnailRequests,
	withContentDisposition,
} from "./utils";

export class AssetService {
	constructor(
		private readonly config: AppConfig,
		readonly db: AssetRepository,
		readonly storage: StorageAdapter = new S3StorageAdapter(config),
	) {}

	async createAssetFromRequest(request: Request) {
		const formData = await request.formData();
		const fileValue = formData.get("file");
		if (!(fileValue instanceof File)) {
			throw new Error("file is required");
		}
		if (fileValue.size === 0) {
			throw new Error("file must not be empty");
		}
		if (fileValue.size > this.config.maxUploadBytes) {
			throw new Error(
				`file exceeds MAX_UPLOAD_BYTES=${this.config.maxUploadBytes}`,
			);
		}

		const metadata = parseJsonField<Record<string, unknown>>(
			formData.get("metadata"),
			"metadata",
			{},
		);
		const search =
			typeof formData.get("search") === "string"
				? String(formData.get("search"))
				: null;
		const temporary = parseBooleanField(formData.get("temporary"), false);
		const ttlSeconds = parseNumberField(
			formData.get("ttlSeconds"),
			"ttlSeconds",
		);
		const focalPoint = validateFocalPoint(
			parseJsonField(formData.get("focalPoint"), "focalPoint", null),
		);
		const thumbnails = validateThumbnailRequests(
			parseJsonField(formData.get("thumbnails"), "thumbnails", []),
		);
		if (temporary && (ttlSeconds == null || ttlSeconds <= 0)) {
			throw new Error("temporary uploads require ttlSeconds > 0");
		}

		const mimeType = await sniffMimeType(fileValue);
		const kind = classifyAssetKind(mimeType);
		const checksum = await sha256Hex(fileValue);
		const normalizedName = normalizeFilename(fileValue.name || "upload.bin");
		const assetId = crypto.randomUUID();
		const storageKey = join(
			this.config.s3Prefix,
			assetId.slice(0, 2),
			assetId,
			`original-${normalizedName}`,
		).replaceAll("\\", "/");
		await this.storage.put(storageKey, fileValue, mimeType);

		const imageMetadata =
			kind === "image" ? await extractImageMetadata(fileValue) : null;
		const typedMetadata: Record<string, unknown> = imageMetadata
			? {
					width: imageMetadata.width,
					height: imageMetadata.height,
					focalPoint,
				}
			: kind === "image" && focalPoint
				? { focalPoint }
				: {};
		const searchText = buildSearchText(
			search,
			metadata,
			fileValue.name || normalizedName,
		);
		const expiresAt =
			ttlSeconds != null && ttlSeconds > 0
				? new Date(Date.now() + ttlSeconds * 1000).toISOString()
				: null;
		const status = thumbnails.length > 0 ? "processing" : "ready";

		const asset = await this.db.insertAsset({
			id: assetId,
			originalFilename: fileValue.name || normalizedName,
			normalizedName,
			mimeType,
			size: fileValue.size,
			checksum,
			storageAdapter: this.storage.name,
			storageKey,
			kind,
			status,
			searchText: searchText || null,
			metadata,
			typedMetadata,
			expiresAt,
			error: null,
		});

		if (thumbnails.length > 0) {
			if (kind !== "image") {
				await this.db.updateAssetStatus(
					asset.id,
					"failed",
					"Thumbnail requests are only supported for image assets",
				);
			} else {
				for (const thumb of thumbnails) {
					await this.db.enqueueJob("thumbnail.generate", {
						assetId: asset.id,
						derivativeName: thumb.name,
						request: thumb,
						focalPoint,
					} satisfies ThumbnailJobPayload);
				}
			}
		}

		return await this.db.getAssetById(asset.id);
	}

	async listAssets(url: URL) {
		const limit = Math.min(
			Math.max(Number(url.searchParams.get("limit") ?? "20"), 1),
			100,
		);
		const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
		const sortBy = url.searchParams.get("sortBy") ?? "created_at";
		const sortDirection =
			url.searchParams.get("sortDirection") === "asc" ? "asc" : "desc";
		const metadata = parseJsonQuery(url, "metadata");
		const typedMetadata = parseJsonQuery(url, "typedMetadata");

		const result = await this.db.listAssets({
			limit,
			offset,
			sortBy,
			sortDirection,
			kind: url.searchParams.get("kind"),
			mimeType: url.searchParams.get("mimeType"),
			status: url.searchParams.get("status"),
			search: url.searchParams.get("search"),
			createdAtFrom: url.searchParams.get("createdAtFrom"),
			createdAtTo: url.searchParams.get("createdAtTo"),
			expiresAtFrom: url.searchParams.get("expiresAtFrom"),
			expiresAtTo: url.searchParams.get("expiresAtTo"),
			metadata,
			typedMetadata,
		});

		return {
			data: result.rows,
			pagination: {
				limit,
				offset,
				total: result.total,
			},
		};
	}

	async getAsset(id: string) {
		return await this.db.getAssetById(id);
	}

	async getOriginalFileResponse(id: string) {
		const asset = await this.db.getAssetById(id);
		if (!asset) return null;
		const object = await this.storage.get(asset.storage_key);
		return new Response(object.body, {
			headers: {
				"content-type": asset.mime_type,
				"content-length": String(asset.size),
				"content-disposition": withContentDisposition(asset.original_filename),
				"x-checksum-sha256": asset.checksum,
			},
		});
	}

	async getDerivativeFileResponse(id: string, name: string) {
		const derivative = await this.db.getDerivative(id, name);
		if (!derivative) return null;
		const object = await this.storage.get(derivative.storage_key);
		return new Response(object.body, {
			headers: {
				"content-type": derivative.mime_type,
				"content-length": String(derivative.size),
				"content-disposition": withContentDisposition(
					`${name}.${derivative.mime_type.split("/")[1] ?? "bin"}`,
				),
			},
		});
	}

	async deleteAsset(id: string) {
		const existing = await this.db.getAssetById(id);
		if (!existing) return null;
		for (const derivative of existing.derivatives) {
			await this.storage.delete(derivative.storage_key);
		}
		await this.storage.delete(existing.storage_key);
		await this.db.deleteAsset(id);
		return { deleted: true, id };
	}

	async cleanupExpired() {
		const rows = await this.db.listExpiredAssetRows(100);
		let deletedAssets = 0;
		let deletedDerivatives = 0;
		for (const asset of rows) {
			const full = await this.db.getAssetById(asset.id);
			if (!full) continue;
			for (const derivative of full.derivatives) {
				await this.storage.delete(derivative.storage_key);
				deletedDerivatives += 1;
			}
			await this.storage.delete(full.storage_key);
			await this.db.deleteAsset(full.id);
			deletedAssets += 1;
		}
		return {
			deletedAssets,
			deletedDerivatives,
			checkedAt: nowIso(),
		};
	}

	async processThumbnailJob(payload: ThumbnailJobPayload) {
		const asset = await this.db.getAssetById(payload.assetId);
		if (!asset) {
			throw new Error(`Asset not found: ${payload.assetId}`);
		}
		if (asset.kind !== "image") {
			throw new Error("Only image assets support derivative generation");
		}
		const source = await this.storage.get(asset.storage_key);
		const sourceBlob = await new Response(source.body).blob();
		const sourceMetadata = await extractImageMetadata(sourceBlob);
		if (!sourceMetadata) {
			throw new Error("Unable to decode source image");
		}
		const derivative = await createDerivativeImage(
			sourceBlob,
			payload.request,
			sourceMetadata,
			payload.focalPoint,
		);
		const storageKey = join(
			this.config.s3Prefix,
			asset.id.slice(0, 2),
			asset.id,
			"derivatives",
			`${payload.derivativeName}.${payload.request.format === "jpeg" ? "jpg" : payload.request.format}`,
		).replaceAll("\\", "/");
		const derivativeBuffer = new Uint8Array(derivative.bytes.byteLength);
		derivativeBuffer.set(derivative.bytes);
		await this.storage.put(
			storageKey,
			new Blob([derivativeBuffer.buffer], { type: derivative.mimeType }),
			derivative.mimeType,
		);
		await this.db.insertDerivative({
			assetId: asset.id,
			name: payload.derivativeName,
			storageAdapter: this.storage.name,
			storageKey,
			mimeType: derivative.mimeType,
			size: derivative.bytes.byteLength,
			metadata: derivative.metadata,
		});
		return asset.id;
	}
}
