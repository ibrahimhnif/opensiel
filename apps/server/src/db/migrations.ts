export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    name: "0001_init",
    sql: `
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index users_email_uq on users (email);

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now()
);

create unique index orgs_slug_uq on orgs (slug);

create table org_members (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_idx on org_members (user_id);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index sessions_token_hash_uq on sessions (token_hash);

create index sessions_user_idx on sessions (user_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  slug text not null,
  dek_wrapped text not null,
  dek_iv text not null,
  dek_tag text not null,
  created_at timestamptz not null default now()
);

create unique index projects_org_slug_uq on projects (org_id, slug);

create table environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  slug text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index environments_project_slug_uq on environments (project_id, slug);

create table secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid not null references environments(id) on delete cascade,
  path text not null default '/',
  key text not null,
  latest_version integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index secrets_active_uq on secrets (project_id, environment_id, path, key) where deleted_at is null;

create index secrets_lookup_idx on secrets (project_id, environment_id);

create table secret_versions (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid not null references secrets(id) on delete cascade,
  version integer not null,
  ciphertext text not null,
  iv text not null,
  tag text not null,
  fingerprint text not null,
  comment text,
  created_by_type text not null,
  created_by_id text not null,
  created_at timestamptz not null default now()
);

create unique index secret_versions_secret_version_uq on secret_versions (secret_id, version);

create table identities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  client_id text not null,
  secret_hash text not null,
  role text not null default 'viewer',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index identities_client_id_uq on identities (client_id);

create index identities_project_idx on identities (project_id);

create table identity_scopes (
  identity_id uuid not null references identities(id) on delete cascade,
  environment_id uuid not null references environments(id) on delete cascade,
  primary key (identity_id, environment_id)
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  actor_type text not null,
  actor_id text not null,
  actor_name text not null,
  action text not null,
  resource_type text not null,
  resource_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);

create index audit_logs_org_created_idx on audit_logs (org_id, created_at);

create index audit_logs_project_created_idx on audit_logs (project_id, created_at);
`,
  },
  {
    name: "0002_org_invites",
    sql: `
create table org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  token_hash text not null,
  invited_by uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index org_invites_token_hash_uq on org_invites (token_hash);

create index org_invites_org_idx on org_invites (org_id);

create unique index org_invites_pending_uq on org_invites (org_id, email) where accepted_at is null;
`,
  },
  {
    name: "0003_approvals",
    sql: `
alter table environments add column approval_required boolean not null default false;

alter table environments add column required_approvals integer not null default 1;

create table change_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid not null references environments(id) on delete cascade,
  action text not null,
  secret_key text not null,
  path text not null,
  target_version integer,
  payload_ciphertext text,
  payload_iv text,
  payload_tag text,
  comment text,
  status text not null default 'pending',
  requested_by_type text not null,
  requested_by_id text not null,
  requested_by_name text not null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  decision_note text
);

create index change_requests_project_status_idx on change_requests (project_id, status, requested_at);

create index change_requests_environment_idx on change_requests (environment_id, status);

create table change_request_approvals (
  request_id uuid not null references change_requests(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  decision text not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
`,
  },
];
