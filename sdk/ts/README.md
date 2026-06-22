# @njxqlus/jean-claude-bun-dam-sdk

One-file TypeScript SDK for the Jean-Claude Bun-DAM media asset service.

## Configuration

Set `JEAN_CLAUDE_BUN_DAM_SERVER_URL` to your service base URL, for example `http://localhost:3000`.

You can also pass `baseUrl` directly when creating the client.

## Usage

```ts
import { createClient } from "@njxqlus/jean-claude-bun-dam-sdk";

const client = createClient();

const asset = await client.createAsset({
  file: new File(["hello"], "hello.txt", { type: "text/plain" }),
  metadata: { project: "alpha" },
});

const list = await client.listAssets({ kind: "document" });
const original = await client.getAssetFile(asset.id);
```

## Commands

```bash
bun install
bun run check
bun run build
```
