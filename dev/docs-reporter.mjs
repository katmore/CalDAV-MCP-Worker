// A Vitest reporter. The tests run inside Cloudflare's runtime, which has no file access, so a
// test attaches the data the docs need to its result (task.meta) and this reporter, which runs
// in plain Node, writes it to test-results/ for dev/refresh-docs.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';

export default class DocsReporter {
  onTestRunEnd(testModules) {
    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        const { tools } = test.meta();
        if (!tools) continue;
        mkdirSync('test-results', { recursive: true });
        writeFileSync('test-results/tools.json', JSON.stringify(tools, null, 2) + '\n');
      }
    }
  }
}
