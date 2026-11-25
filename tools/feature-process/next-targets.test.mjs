import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { measureManifest } from '../../.claude/skills/feature-adr/scripts/check-review-convergence.mjs';
import { parseExpectedTargetBlock } from '../../.claude/skills/feature-adr/scripts/expected-target-grammar.mjs';
import { checkoutEnvironment, repoRoot } from './repo-paths.mjs';

const nextRoot = 'apps/web/src/app';
const routes = [
  `${nextRoot}/preview/[jobId]/PreviewScreen.tsx`,
  `${nextRoot}/dashboard/bots/[botId]/BotScreen.tsx`,
];
const scripts = join(repoRoot, '.claude/skills/feature-adr/scripts');
const feature = 'features/route-check';
const requirements = `${feature}/01_requirements.md`;
const implementationPlan = `${feature}/06_implementation_plan.md`;

function targetBlock(targets) {
  return ['EXPECTED_CODE_TARGETS:', ...targets.map(path => `- ${path}`), ''].join('\n');
}

function plan(targets) {
  return `# Route target fixture
Inputs read: the local Next.js route source files and the shared target grammar.
This fixture checks exact target identities and checks that the ordinary implementation plan remains valid with existing dynamic directories.

## Tasks
- Inspect both literal paths and compare their measured paths to the declared ones.

## Amendments
None

${targetBlock(targets)}`;
}

function put(root, path, content) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, env: checkoutEnvironment(), stdio: 'pipe' });
}

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'sufler-next-targets-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  for (const route of routes) {
    const destination = join(root, route);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, route), destination);
  }
  git(root, 'add', '--', ...routes);
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Track fixture routes');
  put(root, requirements, '# Requirements\n\nMeasure exact route paths.\n');
  put(root, implementationPlan, plan(routes));
  return root;
}

function run(root, script, args) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd: root, env: checkoutEnvironment(), encoding: 'utf8',
  });
}

function k2(root) {
  return run(root, 'check-plan-completeness.mjs', [feature, '--tier=S', '--require-requirements']);
}

test('the parser preserves the ordered set of literal route and ordinary paths', () => {
  const targets = [...routes, `${nextRoot}/browse/[...slug]/page.tsx`, `${nextRoot}/[[...path_2]]/route.ts`, 'docs/.style-guide.md'];
  assert.deepEqual(parseExpectedTargetBlock(targetBlock(targets)), { ok: true, targets, startLine: 0 });
});

test('malformed paths and declarations refuse the entire target set', () => {
  const invalid = [
    `${nextRoot}/[id](reference)/page.tsx`, `[ref](${routes[0]})`, `${nextRoot}/*/page.tsx`,
    `${nextRoot}/[a-z]/page.tsx`, `${nextRoot}/[0]/page.tsx`, `${nextRoot}/dir[id]/page.tsx`,
    `${nextRoot}/[id/page.tsx`, `${nextRoot}/[[id]]/page.tsx`, `${nextRoot}/[...]/page.tsx`,
    `${nextRoot}/[id]`, `${nextRoot}/[id]/`, `${nextRoot}/[id].tsx`, `docs/[id]/x.md`,
    `/${routes[0]}`, `./${routes[0]}`, `${nextRoot}/../[id]/page.tsx`, `${nextRoot}//[id]/page.tsx`,
    'C:\\app\\[id]\\page.tsx', `${nextRoot}/[id]/ page.tsx`,
  ];
  for (const candidate of invalid) {
    const result = parseExpectedTargetBlock(targetBlock([routes[0], candidate]));
    assert.equal(result.ok, false, candidate);
    assert.deepEqual(result.targets, [], candidate);
    assert.equal(result.rejected[0].path, candidate);
  }
  for (const block of [
    targetBlock(routes).replaceAll('\n', '\r\n'),
    targetBlock([`${nextRoot}/[\nid]/page.tsx`]),
    targetBlock([`${routes[0]}\u2028`]),
    targetBlock(routes) + targetBlock(routes),
  ]) assert.equal(parseExpectedTargetBlock(block).ok, false);
});

test('K2 and native target admission accept existing routes with the original path identities', context => {
  const root = fixture(context);
  const gate = k2(root);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /C9: twin scan over 2 target\(s\), 2 on disk/);
  assert.match(gate.stdout, /K2 plan-completeness: PASS/);
  const admission = run(root, 'check-code-targets.mjs', ['--repo', root, '--feature', feature]);
  assert.equal(admission.status, 0, admission.stdout + admission.stderr);
  assert.equal(JSON.parse(admission.stdout).status, 'admitted');
  const manifest = measureManifest(root, join(root, feature), 'qe');
  for (const route of routes) {
    assert.equal(manifest.find(item => item.path === route)?.digest,
      createHash('sha256').update(readFileSync(join(root, route))).digest('hex'));
  }
  const prepare = run(root, 'check-review-convergence.mjs', [
    'prepare', '--repo', root, '--feature', feature, '--phase', 'qe',
    '--reviewers', JSON.stringify([{ id: 'qe-primary', family: 'codex' }]),
  ]);
  assert.equal(prepare.status, 0, prepare.stdout + prepare.stderr);
  const snapshot = JSON.parse(prepare.stdout);
  assert.equal(snapshot.verdict, 'prepared');
  assert.deepEqual(snapshot.manifest, manifest);
});

test('K2 and native admission retain refusal for malformed paths and actual directories', context => {
  const root = fixture(context);
  put(root, implementationPlan, plan([`${nextRoot}/part[id]/page.tsx`]));
  const gate = k2(root);
  assert.equal(gate.status, 1);
  assert.match(gate.stdout, /FAIL  C3: target line rejected:.*markdown residue/);
  assert.throws(() => measureManifest(root, join(root, feature), 'qe'), /target-path-invalid/);
  put(root, implementationPlan, plan([`${nextRoot}/dashboard/bots/`]));
  assert.match(k2(root).stdout, /FAIL  C3: target line rejected:.*trailing slash/);
  put(root, implementationPlan, plan([`${nextRoot}/dashboard/bots`]));
  assert.throws(() => measureManifest(root, join(root, feature), 'qe'), /non-file-artifact/);
});

test('K2 still finds an unlisted route copy and a requirement without a task', context => {
  const root = fixture(context);
  const twin = `${nextRoot}/preview/[jobId]/DuplicatePreviewScreen.tsx`;
  copyFileSync(join(root, routes[0]), join(root, twin));
  git(root, 'add', '--', twin);
  put(root, requirements, '# Requirements\n\n### FR-17 Uncovered requirement\n');
  const gate = k2(root);
  assert.equal(gate.status, 1);
  assert.match(gate.stdout, /FAIL  C8: FR-17/);
  assert.match(gate.stdout, /FAIL  C9: target .*has a byte-identical twin/);
  assert.ok(gate.stdout.includes(twin));
});
