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
  {
    name: "0004_secret_references",
    sql: `
create table environment_imports (
  target_environment_id uuid primary key references environments(id) on delete cascade,
  source_environment_id uuid not null references environments(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint environment_imports_distinct check (target_environment_id <> source_environment_id)
);
`,
  },
  {
    name: "0005_dynamic_secrets",
    sql: `
create table dynamic_secret_configs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  provider text not null default 'postgres',
  admin_url_ciphertext text not null,
  admin_url_iv text not null,
  admin_url_tag text not null,
  creation_statement text not null,
  revocation_statement text not null,
  ttl_seconds integer not null default 3600,
  created_at timestamptz not null default now()
);

create unique index dynamic_secret_configs_project_name_uq on dynamic_secret_configs (project_id, name);

create table dynamic_secret_leases (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references dynamic_secret_configs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  username text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by_type text not null,
  created_by_id text not null,
  created_by_name text not null,
  created_at timestamptz not null default now()
);

create index dynamic_secret_leases_config_idx on dynamic_secret_leases (config_id, expires_at);
`,
  },
  {
    name: "0006_kek_version",
    sql: `
alter table projects add column kek_version integer not null default 1;
`,
  },
  {
    name: "0007_webhooks",
    sql: `
create table webhooks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  url text not null,
  secret_ciphertext text not null,
  secret_iv text not null,
  secret_tag text not null,
  events jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  last_status integer,
  last_error text,
  last_delivery_at timestamptz,
  failure_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index webhooks_project_idx on webhooks (project_id);
`,
  },
  {
    name: "0008_keyed_fingerprints",
    sql: `
alter table secret_versions add column fingerprint_version integer not null default 1;

alter table secret_versions alter column fingerprint_version set default 2;
`,
  },
  {
    name: "0009_transit_keys",
    sql: `
create table transit_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  version integer not null default 1,
  wrapped text not null,
  iv text not null,
  tag text not null,
  created_at timestamptz not null default now(),
  unique (project_id, name, version)
);
`,
  },
  {
    name: "0010_identity_token_policy",
    sql: `
alter table identities add column token_version integer not null default 1;

alter table identities add column token_ttl_seconds integer not null default 900;

alter table identities add column ip_allowlist jsonb;

alter table identities add column hourly_token_cap integer;
`,
  },
  {
    name: "0011_audit_sink_state",
    sql: `
alter table audit_logs add column seq bigserial;

create table audit_sink_state (
  id text primary key,
  last_seq bigint not null default 0,
  failure_count integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  last_success_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into audit_sink_state (id) values ('default') on conflict (id) do nothing;
`,
  },
  {
    name: "0012_mfa",
    sql: `
alter table orgs add column mfa_required boolean not null default false;

create table user_mfa (
  user_id uuid primary key references users(id) on delete cascade,
  secret_ciphertext text not null,
  secret_iv text not null,
  secret_tag text not null,
  enabled boolean not null default false,
  last_used_step bigint,
  created_at timestamptz not null default now(),
  enabled_at timestamptz
);

create table user_mfa_recovery_codes (
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, code_hash)
);
`,
  },
  {
    name: "0013_identity_auth_methods",
    sql: `
create table identity_auth_methods (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references identities(id) on delete cascade,
  type text not null default 'jwt',
  issuer text not null,
  audience text not null,
  jwks_uri text not null,
  allowed_subjects jsonb,
  created_at timestamptz not null default now()
);

create index identity_auth_methods_identity_idx on identity_auth_methods (identity_id);
`,
  },
  {
    name: "0014_rotation_policies",
    sql: `
create table rotation_policies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid not null references environments(id) on delete cascade,
  path text not null default '/',
  secret_key text not null,
  provider text not null,
  config_ciphertext text not null,
  config_iv text not null,
  config_tag text not null,
  interval_seconds integer not null default 2592000,
  grace_seconds integer not null default 3600,
  enabled boolean not null default true,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_status text,
  last_error text,
  failure_count integer not null default 0,
  previous_ciphertext text,
  previous_iv text,
  previous_tag text,
  previous_revoke_after timestamptz,
  current_ciphertext text,
  current_iv text,
  current_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index rotation_policies_target_uq
  on rotation_policies (project_id, environment_id, path, secret_key);

create index rotation_policies_due_idx on rotation_policies (enabled, next_run_at);
`,
  },
  {
    name: "0015_custom_roles",
    sql: `
create table custom_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create unique index custom_roles_org_name_uq on custom_roles (org_id, name);

create table role_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  role_id uuid not null references custom_roles(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  environment_id uuid references environments(id) on delete cascade,
  path text,
  expires_at timestamptz,
  created_by uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index role_grants_user_idx on role_grants (user_id, org_id);
`,
  },
  {
    name: "0016_secret_syncs",
    sql: `
create table secret_syncs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid not null references environments(id) on delete cascade,
  path text not null default '/',
  provider text not null,
  config_ciphertext text not null,
  config_iv text not null,
  config_tag text not null,
  enabled boolean not null default true,
  interval_seconds integer not null default 300,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_status text,
  last_error text,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index secret_syncs_due_idx on secret_syncs (enabled, next_run_at);
`,
  },
  {
    name: "0017_identity_aws_auth",
    sql: `
alter table identity_auth_methods alter column issuer drop not null;
alter table identity_auth_methods alter column audience drop not null;
alter table identity_auth_methods alter column jwks_uri drop not null;
alter table identity_auth_methods add column config jsonb;

create table aws_auth_nonces (
  sig_hash text primary key,
  expires_at timestamptz not null
);

create index aws_auth_nonces_expires_idx on aws_auth_nonces (expires_at);
`,
  },
  {
    name: "0018_e2ee",
    sql: `
alter table projects add column encryption_mode text not null default 'server';

alter table secret_versions add column encryption_mode text not null default 'server';
alter table secret_versions add column key_version integer;

create table user_keys (
  user_id uuid primary key references users(id) on delete cascade,
  public_key text not null,
  wrapped_private_key text not null,
  private_key_iv text not null,
  private_key_tag text not null,
  kdf_salt text not null,
  kdf_params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_member_keys (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  wrapped_key text not null,
  iv text not null,
  tag text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
`,
  },
];
