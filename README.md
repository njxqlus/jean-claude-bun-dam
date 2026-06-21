# Media Asset Service

Self-hosted, API-first media asset microservice built with Bun and TypeScript for storing immutable files, metadata, and image derivatives behind a private API proxy.

## Purpose

This service is meant to be reused across internal projects that need:

- durable media storage in S3-compatible object storage
- PostgreSQL-backed metadata and background jobs
- API-only file access with no public bucket URLs
- upload-time derivative generation for images
- temporary asset expiration and cleanup

## Stack

- Bun 1.3+
- TypeScript
- PostgreSQL
- S3-compatible storage via Bun `S3Client`
- MinIO for local Docker development
- PostgreSQL jobs table with an internal Bun worker loop

## What it does

- stores immutable assets and metadata
- proxies original files and derivatives through REST endpoints
- supports JSONB filtering on `metadata` and `typed_metadata`
- generates image thumbnails
- cleans up expired temporary assets and derivative objects

## What it does not do

- auth
- users
- permissions
- UI
- public URLs
- versioning
- collections
- workflow orchestration
- OpenAPI or Swagger

## Project layout

- `src/index.ts` HTTP server
- `src/service.ts` application service
- `src/db.ts` Bun SQL repository and migration runner
- `src/storage.ts` storage adapter interface and S3 adapter
- `src/worker.ts` PostgreSQL-backed background worker
- `src/migrations/001_init.sql` schema

## Environment variables

Copy `.env.example` to `.env`.

| Variable | Required | Description |
| --- | --- | --- |
| `APP_ENV` | no | Environment name |
| `PORT` | no | HTTP port, default `3000` |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `S3_ENDPOINT` | yes | S3 or MinIO endpoint |
| `S3_REGION` | yes | S3 region |
| `S3_BUCKET` | yes | Bucket name |
| `S3_ACCESS_KEY_ID` | yes | S3 access key |
| `S3_SECRET_ACCESS_KEY` | yes | S3 secret |
| `S3_PATH_STYLE` | no | `true` for MinIO/path-style access |
| `S3_PREFIX` | no | Object key prefix, default `assets` |
| `MAX_UPLOAD_BYTES` | no | Max upload size in bytes |
| `CLEANUP_INTERVAL_SECONDS` | no | Periodic cleanup job enqueue interval |
| `WORKER_POLL_INTERVAL_MS` | no | Job polling interval |

## Docker-first setup

1. Create `.env` from `.env.example`.
2. Start the stack:

```bash
docker compose up --build
```

The service will be available at `http://localhost:3000`.

MinIO API will be available at `http://localhost:9002` and the MinIO console at `http://localhost:9003`.

## Local Bun setup

```bash
bun install
bun run migrate
bun run dev
```

If you run the service directly on the host instead of Docker, point `DATABASE_URL` at `localhost` and make sure ImageMagick is installed for `cover` thumbnails.

## Development commands

The project uses Bun scripts from `package.json`:

```bash
bun run dev        # start the server in watch mode
bun run start      # start the server once
bun run migrate    # run database migrations
bun run test       # run integration tests with Bun
bun run typecheck  # run TypeScript without emitting files
bun run check      # run Biome checks and TypeScript type checks
bun run fix        # run Biome checks and write safe fixes
```

## Testing approach

Tests use Bun's built-in test runner and focus on endpoint-level integration coverage.

- tests exercise the real HTTP request handlers and `AssetService` behavior
- tests mock only infrastructure boundaries: the database repository and object storage adapter
- tests do not add unit-level coverage for internal helpers
- all REST endpoints should be covered through request/response assertions

Run the test suite with:

```bash
bun run test
```

## Code style and linting

Biome is used for formatting and linting, and `bun run check` also runs TypeScript type checking.

```bash
bun run check
bun run fix
```

`bun run fix` applies Biome's safe auto-fixes, while `bun run check` verifies both Biome rules and TypeScript types without modifying files.

## Database migrations

Migrations are plain SQL files in `src/migrations`.

Run them with:

```bash
bun run migrate
```

Applied versions are tracked in `schema_migrations`.

## Storage adapter design

The service uses a small adapter interface:

- `put(key, body, contentType)`
- `get(key)`
- `delete(key)`

Current implementation:

- `S3StorageAdapter` backed by Bun `S3Client`
- compatible with AWS S3 and MinIO

All asset reads go through API endpoints. The service does not return bucket URLs or presigned URLs.

## Data model

### `assets`

- `id`
- `original_filename`
- `normalized_name`
- `mime_type`
- `size`
- `checksum`
- `storage_adapter`
- `storage_key`
- `kind`
- `status`
- `search_text`
- `metadata` JSONB
- `typed_metadata` JSONB
- `created_at`
- `expires_at`
- `error`

### `asset_derivatives`

- derivative metadata for thumbnails
- linked to `assets.id`
- unique per `asset_id + name`

### `jobs`

- `status`
- `payload`
- `attempts`
- `max_attempts`
- `run_after`
- `locked_at`
- `locked_by`
- `error`
- timestamps

## Asset rules

- assets are immutable after upload
- no asset versioning
- file access is always proxied through the API

## Thumbnail behavior

- thumbnail jobs are stored in PostgreSQL
- jobs survive process restarts
- `inside` resizing uses Bun `Image`
- `cover` thumbnails use focal-point crop coordinates and ImageMagick inside the container because Bun `Image` currently does not expose focal crop controls
- derivatives are stored in S3 and recorded in `asset_derivatives`

## Cleanup behavior

- temporary assets use `ttlSeconds` and `expires_at`
- the service periodically enqueues cleanup work
- expired assets can also be deleted manually through `POST /internal/cleanup-expired`
- cleanup deletes both DB rows and storage objects

## REST endpoints

### `POST /assets`

Multipart upload endpoint.

Fields:

- `file` required
- `metadata` JSON string required for structured metadata, use `{}` if empty
- `search` optional string
- `temporary` optional boolean
- `ttlSeconds` optional number
- `focalPoint` optional JSON object like `{"x":0.5,"y":0.5}`
- `thumbnails` optional JSON array

Thumbnail example:

```json
[
  {
    "name": "thumb",
    "width": 300,
    "height": 300,
    "fit": "cover",
    "format": "webp",
    "quality": 82
  }
]
```

Response:

- `201 Created`
- asset record with derivatives array

### `GET /assets`

List assets with pagination, sorting, and filters.

Query parameters:

- `limit`
- `offset`
- `sortBy`: `created_at`, `expires_at`, `mime_type`, `kind`, `status`, `size`
- `sortDirection`: `asc` or `desc`
- `kind`
- `mimeType`
- `status`
- `createdAtFrom`
- `createdAtTo`
- `expiresAtFrom`
- `expiresAtTo`
- `search`
- `metadata` JSON object string, filtered with JSONB containment
- `typedMetadata` JSON object string, filtered with JSONB containment

### `GET /assets/:id`

Returns a single asset and its derivatives.

### `GET /assets/:id/file`

Streams the original file through the service.

### `GET /assets/:id/derivatives/:name`

Streams a named derivative through the service.

### `DELETE /assets/:id`

Deletes the asset record and all underlying storage objects.

### `POST /internal/cleanup-expired`

Runs expired asset cleanup immediately and returns counters.

## curl examples

### Upload an asset

```bash
curl -X POST http://localhost:3000/assets \
  -F 'file=@./example.jpg' \
  -F 'metadata={"project":"alpha","owner":"ops"}' \
  -F 'search=alpha hero image'
```

### Upload with temporary TTL, focal point, and thumbnails

```bash
curl -X POST http://localhost:3000/assets \
  -F 'file=@./example.jpg' \
  -F 'metadata={"project":"alpha","tags":["hero","homepage"]}' \
  -F 'temporary=true' \
  -F 'ttlSeconds=3600' \
  -F 'focalPoint={"x":0.42,"y":0.33}' \
  -F 'thumbnails=[{"name":"thumb","width":300,"height":300,"fit":"cover","format":"webp","quality":82},{"name":"card","width":1200,"height":630,"fit":"cover","format":"jpeg","quality":84}]'
```

### List assets

```bash
curl 'http://localhost:3000/assets?limit=20&offset=0&sortBy=created_at&sortDirection=desc'
```

### Filter by standard fields

```bash
curl 'http://localhost:3000/assets?kind=image&status=ready&mimeType=image/jpeg'
```

### Search text

```bash
curl 'http://localhost:3000/assets?search=hero'
```

### Filter by `metadata` JSONB

```bash
curl --get 'http://localhost:3000/assets' \
  --data-urlencode 'metadata={"project":"alpha"}'
```

### Filter by `typed_metadata` JSONB

```bash
curl --get 'http://localhost:3000/assets' \
  --data-urlencode 'typedMetadata={"width":300,"focalPoint":{"x":0.42,"y":0.33}}'
```

### Get asset details

```bash
curl http://localhost:3000/assets/<asset-id>
```

### Stream original file

```bash
curl -L http://localhost:3000/assets/<asset-id>/file -o original.bin
```

### Stream derivative

```bash
curl -L http://localhost:3000/assets/<asset-id>/derivatives/thumb -o thumb.webp
```

### Delete an asset

```bash
curl -X DELETE http://localhost:3000/assets/<asset-id>
```

### Run cleanup manually

```bash
curl -X POST http://localhost:3000/internal/cleanup-expired
```

## Notes

- `metadata` is for user-defined structured attributes.
- `typed_metadata` is for type-specific structured values such as image dimensions and focal point.
- audio and video typed metadata columns are available through JSONB, but extraction is not implemented in this initial version.
