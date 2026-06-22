import type { AssetService } from "./service";
import { errorResponse, jsonResponse } from "./utils";

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

export function createFetchHandler(service: AssetService) {
	return async function fetch(request: Request) {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/healthz") {
				return jsonResponse({ ok: true });
			}
			if (request.method === "GET" && url.pathname === "/readyz") {
				await service.db.ping();
				return jsonResponse({ ok: true });
			}
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
	};
}

export function createServer(service: AssetService, port: number) {
	return Bun.serve({
		port,
		fetch: createFetchHandler(service),
		error(error) {
			return errorResponse(500, error.message);
		},
	});
}
