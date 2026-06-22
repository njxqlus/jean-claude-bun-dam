# Jean-Claude Bun-DAM

Jean-Claude Bun-DAM is a self-hosted media asset service for private file storage, metadata search, proxied file delivery, and image derivative generation, with a matching TypeScript SDK for application integration.

## What is in this repo

- `service/` Bun microservice with PostgreSQL-backed metadata and jobs
- `sdk/ts/` one-file TypeScript SDK published as `@njxqlus/jean-claude-bun-dam-sdk`

## What the service does

- stores immutable assets and metadata
- proxies original files and derivatives through HTTP endpoints
- supports pagination, sorting, search, and JSON metadata filters
- generates image thumbnails through background jobs
- cleans up expired temporary assets

## Run the microservice

Local Bun setup:

```bash
cd service
bun install
bun run migrate
bun run dev
```

Docker setup:

```bash
cd service
docker compose up --build
```

The service listens on `http://localhost:3000` by default.

Required service configuration lives in `service/.env`; see [service/README.md](/Users/njxqlus/Developer/jean-claude-bun-dam/service/README.md:1) for environment variables, API details, and service development commands.

## Install the SDK

```bash
npm install @njxqlus/jean-claude-bun-dam-sdk
```

The SDK is dependency-light and uses standard `fetch`.

Set the service address before using it:

```bash
export JEAN_CLAUDE_BUN_DAM_SERVER_URL=http://localhost:3000
```

## Use the SDK

```ts
import { createClient } from "@njxqlus/jean-claude-bun-dam-sdk";

const client = createClient();

const asset = await client.createAsset({
  file: new File(["hello"], "hello.txt", { type: "text/plain" }),
  metadata: { project: "alpha" },
});

const assets = await client.listAssets({ search: "alpha" });
const oneAsset = await client.getAsset(asset.id);
const original = await client.getAssetFile(asset.id);
const deleted = await client.deleteAsset(asset.id);
```

Available SDK methods:

- `createAsset`
- `listAssets`
- `getAsset`
- `getAssetFile`
- `getAssetDerivative`
- `deleteAsset`
- `cleanupExpired`

## Repository notes

- the service is the source of truth for the API contract
- the SDK is a thin client over the current HTTP endpoints
- there is no auth layer in the service yet
