#!/usr/bin/env node
// Turns the coverage report from the last test run into a shields.io endpoint file.
//
//   node scripts/coverage-badge.mjs [summary.json] [badge.json]
//
// The number is the lowest of the four coverage figures (lines, statements, functions,
// branches), read from the report vitest wrote, never typed in. The Tests workflow runs this
// on every push to main and publishes the result to the `badges` branch, which the README's
// coverage badge reads.

import { readFileSync, writeFileSync } from 'node:fs';

const [summaryPath = 'coverage/coverage-summary.json', badgePath = 'coverage/badge.json'] = process.argv.slice(2);
const { total } = JSON.parse(readFileSync(summaryPath, 'utf8'));
const figures = ['lines', 'statements', 'functions', 'branches'].map(key => total[key].pct);
const lowest = Math.min(...figures);

const colour = lowest >= 100 ? 'brightgreen' : lowest >= 90 ? 'green' : lowest >= 80 ? 'yellowgreen' : lowest >= 70 ? 'yellow' : 'red';
// Never round up: 99.96 must not read as 100%.
const shown = Math.floor(lowest * 10) / 10;
writeFileSync(badgePath, JSON.stringify({ schemaVersion: 1, label: 'coverage', message: `${shown}%`, color: colour }) + '\n');
console.log(`coverage ${shown}% (${colour}) from ${summaryPath}`);
