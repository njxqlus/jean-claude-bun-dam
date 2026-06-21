import { join } from "node:path";
import { loadConfig } from "./config";
import { Database } from "./db";
import { AssetService } from "./service";
import { errorResponse, jsonResponse } from "./utils";
import { JobWorker } from "./worker";

const config = loadConfig();
const db = new Database(config.databaseUrl);
await db.connect();
await db.migrate(join(import.meta.dir, "migrations"));
const service = new AssetService(config, db);
const worker = new JobWorker(
	service,
	config.workerId,
	config.workerPollIntervalMs,
);
worker.start();

setInterval(() => {
	void db.enqueueJob("cleanup.expired", {}, { maxAttempts: 1 });
}, config.cleanupIntervalSeconds * 1000);

function routeMatch(pathname: string, pattern: RegExp) {
	return pathname.match(pattern);
}

function routeParam(match: RegExpMatchArray, index: number) {
	const value = match[index];
	if (value === undefined) {
		throw new Error("invalid route parameters");
	}
	return value;
}

const server = Bun.serve({
	port: config.port,
	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/assets") {
				const asset = await service.createAssetFromRequest(request);
				return jsonResponse(asset, 201);
			}
			if (request.method === "GET" && url.pathname === "/assets") {
				return jsonResponse(await service.listAssets(url));
			}

			const assetMatch = routeMatch(url.pathname, /^\/assets\/([^/]+)$/);
			if (request.method === "GET" && assetMatch) {
				const asset = await service.getAsset(routeParam(assetMatch, 1));
				return asset
					? jsonResponse(asset)
					: errorResponse(404, "Asset not found");
			}
			if (request.method === "DELETE" && assetMatch) {
				const deleted = await service.deleteAsset(routeParam(assetMatch, 1));
				return deleted
					? jsonResponse(deleted)
					: errorResponse(404, "Asset not found");
			}

			const assetFileMatch = routeMatch(
				url.pathname,
				/^\/assets\/([^/]+)\/file$/,
			);
			if (request.method === "GET" && assetFileMatch) {
				const response = await service.getOriginalFileResponse(
					routeParam(assetFileMatch, 1),
				);
				return response ?? errorResponse(404, "Asset not found");
			}

			const derivativeMatch = routeMatch(
				url.pathname,
				/^\/assets\/([^/]+)\/derivatives\/([^/]+)$/,
			);
			if (request.method === "GET" && derivativeMatch) {
				const response = await service.getDerivativeFileResponse(
					routeParam(derivativeMatch, 1),
					routeParam(derivativeMatch, 2),
				);
				return response ?? errorResponse(404, "Derivative not found");
			}

			if (
				request.method === "POST" &&
				url.pathname === "/internal/cleanup-expired"
			) {
				return jsonResponse(await service.cleanupExpired());
			}

			return errorResponse(404, "Route not found");
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Internal server error";
			return errorResponse(400, message);
		}
	},
	error(error) {
		return errorResponse(500, error.message);
	},
});

console.log(`media asset service listening on http://localhost:${server.port}`);
