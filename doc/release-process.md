# Release process

Codex owns the commit split for each release and should derive it from the diff.
Commit user-facing features and fixes first with Conventional Commit subjects,
then create a separate version commit using
`chore(publish): release v<version>` and tag that commit.

The release generator excludes the version commit from its changelog. Feature
details in that commit's body therefore do not appear in release notes. Keep
feature summaries in the corresponding `feat(...)` commit subjects.

The GitHub tag workflow runs `npm run release:check` before generating release
notes. The check requires a `feat` commit for major or minor version increases,
and a `feat`, `fix`, `perf`, or `revert` commit for patch increases. Resolve a
failed check by correcting the release history before publishing; do not bypass
the check.

After publishing, inspect the GitHub Release body and confirm it describes the
features in the release. If the generated notes miss a feature, correct the
release body.
