#!/usr/bin/env node
// Keeps code copied from another repository explicit and checkable.
//
// Each vendor/<name>/ folder holds:
//   SOURCE.json  where the files came from (repository, path, commit) and where they live in src/
//   upstream/    the files exactly as published at that commit
//   patches/     this project's changes to each file, as unified diffs
//
// Commands:
//   check    (offline) upstream + patches must reproduce src/ exactly. Run by `npm test`.
//   update   regenerate patches/ from the current src/ after an intentional edit.
//   verify   (online) upstream/ must match the recorded commit, and the files must be
//            unchanged upstream since then. Exits 1 if a copy was edited or something
//            went wrong, and 3 if the only finding is that upstream has changed, so a
//            scheduled job can tell "review Cloudflare's changes" apart from "broken".

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const vendors = readdirSync(join(root, 'vendor'), { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => {
    const dir = join(root, 'vendor', d.name);
    return { name: d.name, dir, source: JSON.parse(readFileSync(join(dir, 'SOURCE.json'), 'utf8')) };
  });

const patchPath = (v, file) => join(v.dir, 'patches', `${file}.patch`);
let failed = false;
let upstreamChanged = false;
const fail = message => { console.error(`✖ ${message}`); failed = true; };
const changedUpstream = message => { console.error(`✖ ${message}`); upstreamChanged = true; };
const ok = message => console.log(`✔ ${message}`);

function check() {
  for (const v of vendors) {
    for (const [file, target] of Object.entries(v.source.files)) {
      const work = mkdtempSync(join(tmpdir(), 'vendor-'));
      try {
        copyFileSync(join(v.dir, 'upstream', file), join(work, file));
        if (existsSync(patchPath(v, file))) {
          execFileSync('git', ['apply', '-p1', patchPath(v, file)], { cwd: work, stdio: 'pipe' });
        }
        const expected = readFileSync(join(work, file), 'utf8');
        const actual = readFileSync(join(root, target), 'utf8');
        if (expected === actual) ok(`${v.name}: ${target} matches upstream plus patches`);
        else fail(`${v.name}: ${target} has changes not recorded in vendor/${v.name}/patches/ (run \`npm run vendor:update\` if they're intended)`);
      } catch (e) {
        fail(`${v.name}: patch for ${file} no longer applies (${e.stderr?.toString().trim() || e.message})`);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  }
}

function update() {
  for (const v of vendors) {
    for (const [file, target] of Object.entries(v.source.files)) {
      let diff = '';
      try {
        execFileSync('diff', ['-u', '--label', `a/${file}`, '--label', `b/${file}`, join(v.dir, 'upstream', file), join(root, target)]);
      } catch (e) {
        if (e.status !== 1) throw e;
        diff = e.stdout.toString();
      }
      if (diff) { writeFileSync(patchPath(v, file), diff); ok(`${v.name}: wrote patches/${file}.patch`); }
      else { rmSync(patchPath(v, file), { force: true }); ok(`${v.name}: ${file} is unchanged from upstream`); }
    }
  }
}

async function fetchRaw(source, ref, file) {
  const url = `https://raw.githubusercontent.com/${source.repository}/${ref}/${source.path}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function verify() {
  for (const v of vendors) {
    for (const file of Object.keys(v.source.files)) {
      const local = readFileSync(join(v.dir, 'upstream', file), 'utf8');
      if (await fetchRaw(v.source, v.source.commit, file) === local) ok(`${v.name}: upstream/${file} matches commit ${v.source.commit.slice(0, 7)}`);
      else fail(`${v.name}: upstream/${file} differs from commit ${v.source.commit.slice(0, 7)}; it should never be edited by hand`);
      if (await fetchRaw(v.source, v.source.branch, file) === local) ok(`${v.name}: ${file} is unchanged on ${v.source.branch}`);
      else changedUpstream(`${v.name}: ${file} has changed on ${v.source.branch} since ${v.source.commit.slice(0, 7)}; review upstream before deciding whether to update`);
    }
  }
}

const command = process.argv[2];
if (command === 'check') check();
else if (command === 'update') update();
else if (command === 'verify') await verify();
else { console.error('usage: vendor.mjs check | update | verify'); process.exit(2); }
process.exit(failed ? 1 : upstreamChanged ? 3 : 0);
