# Releasing opensiel

Maintainer checklist for a public release. The release workflow runs on tags matching `v*`.

## 1. Preconditions

- [ ] The repository is public.
- [ ] The GHCR container package is public: **GitHub → your profile → Packages → opensiel →
      Package settings → Change visibility → Public**. The one-command installer and the Helm
      chart pull `ghcr.io/ibrahimhnif/opensiel:<tag>`; while the package is private, pulls fail.
- [ ] The GHCR chart package (`charts/opensiel`) is public if you want OCI installs. The chart
      is also attached to the GitHub release, which works without a public OCI package.
- [ ] The npm organization `liostech` exists and your account can publish to it. Create it at
      <https://www.npmjs.com/org/create> if needed. `@liostech/opensiel-sdk` is scoped, so publishing
      without the org fails.
- [ ] A trusted publisher is configured for `@liostech/opensiel-sdk` (package settings on
      npmjs.com → **Trusted Publisher** → GitHub Actions: owner `ibrahimhnif`, repository
      `opensiel`, workflow `release.yml`, allow `npm publish`). Trusted publishing needs a
      successful publish within 2 days of creating the configuration, so configure it when the
      next version is ready to ship.
- [ ] You are logged in to npm locally only if you want to stage or approve a package manually.
- [ ] Docker is available locally for the installer smoke test.

## 2. Bump versions

Keep these in sync with the tag:

- `package.json` (`version`)
- `packages/sdk/package.json` (`version`)
- `CHANGELOG.md` (move changes under the new version)

```bash
git tag v0.1.0
```

## 3. Publish

```bash
git push origin main
git push origin v0.1.0
```

The tag runs `.github/workflows/release.yml`:

1. `image` builds and pushes `ghcr.io/<owner>/opensiel:v0.1.0`, `:0.1.0`, and `:latest`.
2. `chart` lints, packages, pushes `oci://ghcr.io/<owner>/charts/opensiel:0.1.0`, and uploads
   the chart artifact.
3. `sdk` publishes `@liostech/opensiel-sdk` to npm with provenance using OIDC trusted
   publishing (no npm token).
4. `release` attaches the chart `.tgz` and creates the GitHub release with generated notes.

The tag also makes the repository root `action.yml` usable as
`uses: ibrahimhnif/opensiel@v0.1.0`. Pin the release tag in workflows. Optionally, publish the
action to the GitHub Marketplace from the release page.

If `sdk` fails with `ENEEDAUTH`, check the trusted publisher fields (repository, workflow
filename, and `id-token: write`). If it reports the version already exists, the publish was
already done; that is expected for a re-run.

### First publish: staged publishing

A new package cannot have a trusted publisher until it exists. Use staged publishing for the
first version:

```bash
npm login
pnpm install
pnpm --filter @liostech/opensiel-sdk build

cd packages/sdk
npm pack --dry-run
npm stage publish --access public
npm stage approve <stage-id>   # asks for the 2FA code
```

`npm stage publish` does not require 2FA. The approval does, either with `npm stage approve` or
on npmjs.com under **Staged Packages**. The package has a `prepack` script, so both commands
rebuild `dist` automatically.

Bypass-2FA granular tokens are deprecated for direct publishing (see the
[npm changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).
Do not create a long-lived publish token. Use staged publishing for the first version, then
OIDC trusted publishing for later releases.

After `0.1.0` is approved, create the trusted publisher configuration described in
Preconditions. The release job skips a version that is already on the registry, so the first
tag can still run the image and GitHub release steps.

## 4. Verify

```bash
npm view @liostech/opensiel-sdk version
npm view @liostech/opensiel-sdk dist-tags

docker pull ghcr.io/ibrahimhnif/opensiel:v0.1.0

helm show chart oci://ghcr.io/ibrahimhnif/charts/opensiel --version 0.1.0
helm template opensiel oci://ghcr.io/ibrahimhnif/charts/opensiel --version 0.1.0

curl -fsSL https://opensiel.liostech.id/install.sh | bash -s -- --version v0.1.0
```

- The installer should print the URL and pass its health check.
- The first signup becomes the owner; sign in and create a test project.
- `npm install @liostech/opensiel-sdk` in a scratch directory and import `OpensielClient`.
- `https://opensiel.liostech.id/docs/` should load with the current docs.

## 5. Installer notes

- Default install directory: `~/.opensiel`; data lives in the `opensiel_opensiel-db` Docker
  volume.
- The master key is only in `~/.opensiel/.env`. Back it up separately from the database.
- `--version` pins the image; the default is `latest`.
- `--url` must match how users reach the app (HTTPS in production) for cookies and SSO.
- Re-running the installer updates the image and managed env keys, but preserves existing keys
  and unrelated `.env` entries.

## 6. Rollback

- npm: `npm deprecate @liostech/opensiel-sdk@<version> "reason"`; `npm unpublish` is only possible within
  72 hours and should be avoided once users depend on it. Publish a patch instead.
- GHCR: keep the previous tag; `:latest` can be re-pointed by re-running the release workflow
  for an older tag, or by pushing the previous image as `latest`.
- Installer: users can pin `--version v<previous>`.

## Release checklist

- [ ] Repository public
- [ ] GHCR package public
- [ ] npm org `liostech` exists
- [ ] Trusted publisher configured for the next version
- [ ] Versions and changelog updated
- [ ] Tag pushed
- [ ] `image`, `chart`, `sdk`, and `release` jobs green
- [ ] `npm view`, `docker pull`, `helm show chart`, and installer smoke test pass
- [ ] `uses: ibrahimhnif/opensiel@v<version>` works in a scratch workflow
