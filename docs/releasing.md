```text
Document:    Oopsware Release Notes for Maintainers
Version:     v1.0.2
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      7cefb8d09c16fdebaaa941e90876c06028e6b03244d797cf18233ae56bab2e1c
Chain:       solana-mainnet
Tx:          3iuteLvX4oRzkZZfLaFGpr5eeo5cZLKx3b5ZumSLjKZnW4x7MK9XquhLoFH5GULycRMsAEo91KCYELcd2CDSJjhL
License:     All Rights Reserved / Celaya Solutions
```

# Pack it carefully

Oopsware is installed from source today. Its package identity is
`@celaya-solutions/oopsware`; the inherited runtime version is 6.7.0. Neither
that version nor `server.json` means a CSR package has been published.

For a release, first choose the reviewed commit and run the local checks:

```sh
npm ci
npm run metadata:generate
npm run build:cached
npm run check:fast
npm run docs:check
npm run mcp-registry:check
npm run verify:package
npm pack --dry-run
```

Run the affected public CLI/MCP and real-provider lanes too. Keep provider
claims no broader than the checks actually performed. Inspect the package
contents for the launchers, matching skill, LICENSE, LICENSES, and CREDITS.

Update `package.json`, its lockfile, `server.json`, the skill metadata, and
the changelog together. Generate metadata instead of editing generated
constants. Keep the original MIT notice byte-for-byte intact.

Before cutting a release, review the changelog's breaking changes and the
migration notes for that release. The
[6.1 to 6.2 migration guide](migration-6.2.md) records that release's changes;
it is a historical reference, not the compatibility checklist for later
releases.

## Release notes with credit

The [rea-changelog-update skill](https://github.com/celaya-solutions/oopsware/blob/main/.agents/skills/rea-changelog-update/SKILL.md)
turns a changelog draft into grouped Highlights, Changes, and Fixes with inline
`Thanks @...` credit. `npm run release:notes -- inventory` collects the selected
Git range and its pull request, author, and closing-issue metadata;
`record --summary` produces a compact provenance link, while `record` produces
the full record for review. Credit a contribution once even when it appears in
several sections. `check` validates credits, and `render` writes the verified
release section. Run a subcommand without its required options to see its
usage. Inventory reads need an authenticated `gh`; record, check, and render
work offline from the saved inventory and complete local Git history.

Save a finalized inventory at `docs/releases/VERSION.contributions.json`.
Review unknown identities and reverted or backported work explicitly; hosting
metadata does not establish the quality of a user-facing claim. The inventory
is a reviewed snapshot, not a signed attestation: the offline checker verifies
range coverage and credit consistency, not authorship independently.

## Publishing

Publishing to npm or an MCP registry, creating a public release, and deploying
a website each require an explicit request with the intended destination.
Use the actual platform's tools. Never use GitHub Actions. A future tagged
Oopsware release uses `oopsware-VERSION`; old REA tags are not Oopsware releases.
Upstream REA's Release Please, qualification, and recovery workflows are not
part of this fork.

The installer only looks at the CSR repository and package. If there is no
matching published release, use the source instructions in the README.
