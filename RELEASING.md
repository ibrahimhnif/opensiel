# Releasing opensiel

Maintainer checklist for a public release. The release workflow runs on tags matching `v*`.

## 1. Preconditions

- [ ] The repository is public.
- [ ] The GHCR package is public: **GitHub → your profile → Packages → opensiel → Package
      settings → Change visibility → Public**. The one-command installer pulls
      `ghcr.io/ibrahimhnif/opensiel:<tag>`; while the package is private, `docker compose pull`
      fails.
- [ ] The npm organization `opensiel` exists and your account can publish to it. Create it at
      <https://www.npmjs.com/org/create> if needed. `@opensiel/sdk` is scoped, so publishing
      without the org fails.
- [ ] The GitHub secret `NPM_TOKEN` is set. Use a granular npm token with **Read and write**
      package permissions and **bypass 2FA** enabled. Never commit it.
- [ ] You are logged in to npm locally only if you want to publish manually.
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

1. `image` builds and pushes `ghcr.io/<owner>/opensiel:v0.1.0` and `:latest`.
2. `sdk` publishes `@opensiel/sdk` to npm with provenance.
3. `release` creates the GitHub release with generated notes.

If `sdk` fails with `ENEEDAUTH` or `403`, fix the npm org or `NPM_TOKEN` and re-run the failed
job.

### Manual SDK publish (first release or emergency)

```bash
npm login
pnpm install
pnpm --filter @opensiel/sdk build

# verify the tarball before publishing
cd packages/sdk
npm pack --dry-run

npm publish --access public
```

The package has a `prepack` script, so `npm publish` rebuilds `dist` automatically. Publishing
requires membership in the `opensiel` npm org.

## 4. Verify

```bash
npm view @opensiel/sdk version
npm view @opensiel/sdk dist-tags

docker pull ghcr.io/ibrahimhnif/opensiel:v0.1.0

curl -fsSL https://opensiel.liostech.id/install.sh | bash -s -- --version v0.1.0
```

- The installer should print the URL and pass its health check.
- The first signup becomes the owner; sign in and create a test project.
- `npm install @opensiel/sdk` in a scratch directory and import `OpensielClient`.
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

- npm: `npm deprecate @opensiel/sdk@<version> "reason"`; `npm unpublish` is only possible within
  72 hours and should be avoided once users depend on it. Publish a patch instead.
- GHCR: keep the previous tag; `:latest` can be re-pointed by re-running the release workflow
  for an older tag, or by pushing the previous image as `latest`.
- Installer: users can pin `--version v<previous>`.

## Release checklist

- [ ] Repository public
- [ ] GHCR package public
- [ ] npm org `opensiel` and `NPM_TOKEN` configured
- [ ] Versions and changelog updated
- [ ] Tag pushed
- [ ] `image`, `sdk`, and `release` jobs green
- [ ] `npm view`, `docker pull`, and installer smoke test pass
