#!/usr/bin/env node
// Refreshes the generated blocks in README.md and VALIDATION.md from the output of the real
// tools: the server's tool definitions and the test and coverage reports from `npm test`.
//
//   npm test && npm run docs
//
// Blocks look like `<!-- docs tools -->` ... `<!-- /docs -->`; markdown-magic rewrites what is
// between them and leaves the rest of the file alone. The wording of each block lives in
// dev/templates/, as Markdown with {{placeholders}}.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative } from 'node:path';

const { markdownMagic } = createRequire(import.meta.url)('markdown-magic');

const template = name => readFileSync(new URL(`./templates/${name}.md`, import.meta.url), 'utf8').trimEnd();
const fill = (text, values) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ''));
const data = path => {
  if (!existsSync(path)) throw new Error(`${path} not found. Run \`npm test\` first.`);
  return JSON.parse(readFileSync(path, 'utf8'));
};

// How a parameter's JSON Schema reads in a table cell.
function typeOf(schema) {
  if (schema.const !== undefined) return `\`"${schema.const}"\``;
  if (schema.enum) return schema.enum.map(v => `\`"${v}"\``).join(' or ');
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' or ');
  if (schema.format === 'date-time') return 'date-time';
  if (schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$') return 'date (`YYYY-MM-DD`)';
  return schema.type ?? 'any';
}

function tools() {
  const kind = ({ readOnlyHint, destructiveHint }) =>
    readOnlyHint ? '_Reads your calendar._' : destructiveHint ? '_Changes or deletes events._' : '_Adds to your calendar._';
  const sections = data('test-results/tools.json').map(tool => {
    const { properties, required = [] } = tool.parameters;
    const rows = Object.entries(properties).map(([name, schema]) => fill(template('parameter'), {
      name,
      type: typeOf(schema),
      required: required.includes(name) ? 'yes' : 'no',
      notes: schema.default !== undefined ? `default \`${JSON.stringify(schema.default)}\`` : '',
    }));
    const parameters = rows.length ? fill(template('parameters'), { rows: rows.join('\n') }) : template('no-parameters');
    return fill(template('tool'), { name: tool.name, kind: kind(tool.annotations), description: tool.description, parameters });
  });
  return fill(template('tools'), { tools: sections.join('\n\n') });
}

// Never round up: 99.96% must not read as 100%.
const percent = value => `${Math.floor(value * 10) / 10}%`;

function results() {
  const report = data('test-results/results.json');
  const coverage = data('coverage/coverage-summary.json');
  const rows = Object.entries(coverage).map(([file, c]) => fill(template('coverage-row'), {
    file: file === 'total' ? '**All files**' : `\`${relative(process.cwd(), file)}\``,
    statements: percent(c.statements.pct), branches: percent(c.branches.pct),
    functions: percent(c.functions.pct), lines: percent(c.lines.pct),
  }));
  const tests = report.testResults
    .map(file => ({ name: relative(process.cwd(), file.name), tests: file.assertionResults }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, tests }) => [
      `**\`${name}\`** (${tests.filter(t => t.status === 'passed').length} of ${tests.length})`,
      ...tests.map(t => `- ${t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '-'} ${t.fullName}`),
    ].join('\n'));
  return fill(template('results'), {
    passed: report.numPassedTests, total: report.numTotalTests, files: report.testResults.length,
    failed: report.numFailedTests ? `, ${report.numFailedTests} failed` : '',
    coverageRows: rows.join('\n'), tests: tests.join('\n\n'),
  });
}

await markdownMagic(['README.md', 'VALIDATION.md'], {
  transforms: { tools, results },
  failOnMissingTransforms: true,
});
