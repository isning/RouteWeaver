#!/usr/bin/env node
// Use the installed Vitest discovery and configured sequencer, never a second
// handwritten glob or hash algorithm. `vitest list --filesOnly` ignores shards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const require = createRequire(join(web, 'package.json'));
const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')));
const ctx = await createVitest('test', { root: web, watch: false, maxWorkers: 1 });
try {
  const specs = await ctx.globTestSpecifications();
  const all = specs.map(spec => spec.moduleId).sort();
  assert.ok(all.length >= 2, 'Expected at least two frontend test files');
  assert.equal(ctx.config.isolate, true, 'Frontend file isolation is required');
  const parts = [];
  for (let index = 1; index <= 2; index++) {
    ctx.config.shard = { index, count: 2 };
    const sequencer = new ctx.config.sequence.sequencer(ctx);
    const selected = (await sequencer.shard(specs)).map(spec => spec.moduleId);
    assert.ok(selected.length, `Shard ${index} must not be empty`);
    parts.push(selected);
  }
  assert.equal(new Set(all).size, all.length, 'Duplicate discovery entries');
  assert.deepEqual(parts.flat().sort(), all, 'Shards must cover discovery exactly once');
  console.log(`PASS: configured Vitest discovery: ${all.length} files, shards ${parts.map(p => p.length).join(' + ')}, exact-once coverage.`);
} finally {
  await ctx.close();
}

// Independently exercise real CLI execution, not just selection. No application
// tests run here; tiny fixtures verify both disjoint coverage and assertion failure.
const fixture = mkdtempSync(join(tmpdir(), 'routeweaver-web-shards-'));
try {
  const api = pathToFileURL(join(dirname(require.resolve('vitest/package.json')), 'dist/index.js')).href;
  const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const config = join(fixture, 'vitest.config.mjs');
  writeFileSync(config, 'export default { test: { include: ["*.test.js"] } };\n');
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(fixture, `${i}.test.js`), `import { test, expect } from ${JSON.stringify(api)}; test('fixture ${i}', () => expect(${i}).toBe(${i}));\n`);
  }
  const run = (shard, expectedStatus) => {
    const report = join(fixture, 'report.json');
    rmSync(report, { force: true });
    const result = spawnSync(process.execPath, [cli, 'run', '--root', fixture, '--config', config,
      '--maxWorkers=1', '--shard=' + shard, '--reporter=json', '--outputFile=' + report],
    { cwd: web, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, expectedStatus, `${result.error || ''}\n${result.stdout}\n${result.stderr}\n${existsSync(report) ? readFileSync(report, 'utf8') : 'No JSON report produced'}`);
    return JSON.parse(readFileSync(report, 'utf8'));
  };
  const first = run('1/2', 0);
  const second = run('2/2', 0);
  const names = [first, second].flatMap(report => report.testResults.flatMap(file => file.assertionResults.map(test => test.fullName)));
  assert.deepEqual(names.sort(), Array.from({ length: 5 }, (_, i) => `fixture ${i}`));
  // Every file now fails, so both shards must propagate failure independently.
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(fixture, `${i}.test.js`), `import { test, expect } from ${JSON.stringify(api)}; test('fixture ${i}', () => expect(false).toBe(true));\n`);
  }
  for (const shard of ['1/2', '2/2']) assert.ok(run(shard, 1).numFailedTests > 0);
  console.log('PASS: real Vitest CLI shards execute every fixture exactly once and both propagate assertion failures.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
