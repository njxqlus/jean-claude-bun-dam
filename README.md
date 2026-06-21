# Jean-Claude Bun-Dam

API-first media asset platform built with Bun and TypeScript for internal products that need private file storage, metadata search, and image derivative generation without exposing bucket URLs directly.

## Current status

The repository currently contains the production microservice in `service/`.

Planned next step:

- add a TypeScript SDK as a sibling project once the client surface is stable

## What the service provides

- immutable asset uploads and metadata persistence
- proxied access to originals and generated derivatives
- PostgreSQL-backed jobs for thumbnail generation and cleanup
- S3-compatible object storage support
- temporary asset expiration and deletion workflows

## Stack

- Bun
- TypeScript
- PostgreSQL
- S3-compatible storage
- MinIO for local development

## Repository layout

- `service/` Bun microservice, Docker setup, tests, and service-specific documentation

## Local development

```bash
cd service
bun install
bun run migrate
bun run dev
```

For Docker-based local infrastructure:

```bash
cd service
docker compose up --build
```

See `service/README.md` for service details, environment variables, API behavior, and development commands.
