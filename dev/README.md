# Development tools

## Generated documentation

Some of `README.md` and `VALIDATION.md` is generated from the output of the real tools,
so it can't drift from what the code does or be changed by whichever editor or AI session
happens to be open:

| Where | What | Comes from |
| --- | --- | --- |
| `README.md`, Tools | Every tool, its description and its parameters | The server's own tool definitions |
| `VALIDATION.md`, Latest results | Test counts, every test name, coverage of each file in `src/` | The test and coverage reports |

The generated parts sit between `<!-- docs ... -->` and `<!-- /docs -->` comments. Anything
inside them is overwritten; everything outside is ordinary text.

### Refreshing

```sh
npm test
npm run docs
```

`npm test` writes the reports to `coverage/` and `test-results/` (both ignored by git).
`npm run docs` reads them and rewrites the blocks using [markdown-magic](https://github.com/DavidWells/markdown-magic).

On every push to `main` the Tests workflow does this itself and commits any change as
`github-actions[bot]`, so the published docs always come from a CI run.

### Wording

The wording around the generated values lives in `templates/`. Each template is plain
Markdown with `{{placeholders}}`, so it reads as a page on its own. Change the wording there,
not in the script.

| File | Used for |
| --- | --- |
| `templates/tools.md` | The whole Tools block |
| `templates/tool.md` | One tool |
| `templates/parameters.md` | A tool's parameter table (`templates/parameter.md` is one row, `templates/no-parameters.md` is used when a tool has none) |
| `templates/results.md` | The whole Latest results block |
| `templates/coverage-row.md` | One row of the coverage table |

### How the tool definitions reach the docs

The tests run inside Cloudflare's runtime, which can't write files. One test attaches the
tool definitions to its result, and `docs-reporter.mjs`, a Vitest reporter that runs in
plain Node, writes them to `test-results/tools.json`.

## Badges

A badge may only be green when the thing it names is true. `check-badges.mjs` runs as part of
`npm test` and fails if the README has any badge that isn't from GitHub's workflow status,
Codecov, or shields.io reading the GitHub API. A static label fails the build. When adding a
badge, say in the commit what turns it red and make sure that state can't happen while it is
green.
