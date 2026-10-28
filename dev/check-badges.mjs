#!/usr/bin/env node
// Fails if README.md has a badge that is not backed by something outside this repo's own text.
//
// A badge may only be green when the thing it names is true, so every badge has to come from
// GitHub's workflow status, from Codecov, or from shields.io reading GitHub's API. A static
// label such as img.shields.io/badge/... (or a number typed into a URL) fails the build.
// To allow another source, add it below and say in the commit what turns that badge red.

import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const images = [...readme.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map(m => m[1]);

const allowed = [
  [/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/workflows\/[\w.-]+\/badge\.svg(\?.*)?$/, "GitHub's status for a workflow"],
  [/^https:\/\/codecov\.io\/gh\/[^/]+\/[^/]+\/graph\/badge\.svg$/, "Codecov's coverage for the repository"],
  [/^https:\/\/img\.shields\.io\/github\//, 'shields.io reading the GitHub API'],
];

const bad = images.filter(url => !allowed.some(([pattern]) => pattern.test(url)));
if (bad.length) {
  console.error('README.md has images that are not verified badges:\n' + bad.map(url => `  ${url}`).join('\n'));
  console.error('\nAllowed:\n' + allowed.map(([, what]) => `  ${what}`).join('\n'));
  process.exit(1);
}
console.log(`✔ README.md: ${images.length} badge(s), all from GitHub or Codecov`);
