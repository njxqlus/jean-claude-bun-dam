create table if not exists assets (
  id uuid primary key,
  original_filename text not null,
  normalized_name text not null,
  mime_type text not null,
  size bigint not null check (size >= 0),
  checksum text not null,
  storage_adapter text not null,
  storage_key text not null unique,
  kind text not null check (kind in ('image', 'audio', 'video', 'document', 'other')),
  status text not null check (status in ('processing', 'ready', 'failed', 'expired')),
  search_text text,
  metadata jsonb not null default '{}'::jsonb,
  typed_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  error text
);

create index if not exists assets_kind_idx on assets (kind);
create index if not exists assets_status_idx on assets (status);
create index if not exists assets_mime_type_idx on assets (mime_type);
create index if not exists assets_created_at_idx on assets (created_at desc);
create index if not exists assets_expires_at_idx on assets (expires_at);
create index if not exists assets_metadata_gin_idx on assets using gin (metadata jsonb_path_ops);
create index if not exists assets_typed_metadata_gin_idx on assets using gin (typed_metadata jsonb_path_ops);

create table if not exists asset_derivatives (
  id uuid primary key,
  asset_id uuid not null references assets(id) on delete cascade,
  name text not null,
  storage_adapter text not null,
  storage_key text not null unique,
  mime_type text not null,
  size bigint not null check (size >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (asset_id, name)
);

create index if not exists asset_derivatives_asset_id_idx on asset_derivatives (asset_id);

create table if not exists jobs (
  id uuid primary key,
  type text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed')),
  payload jsonb not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_poll_idx on jobs (status, run_after, created_at);
