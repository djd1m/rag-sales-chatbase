import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkoutEnvironment, checkoutFiles, checkRepoPath, repoRoot } from './repo-paths.mjs';

const expected = {
  0: ['00_complexity_assessment.md'],
  1: ['01_requirements.md'],
  2: ['02_research.md'],
  3: ['03_adr/*.md'],
  '3.5': ['03.5_ideation_report.md'],
  4: ['04_domain_model.md'],
  5: ['05_architecture.md', 'diagrams/*.mermaid'],
  6: ['06_implementation_plan.md'],
  7: ['07_code_changes/change_manifest.md'],
  8: ['08_qe_report.md'],
  9: ['09_fleet_qe_assessment.md'],
  10: ['10_delivery_review.md'],
};
const active = {
  S: ['0', '1', '6', '7', '8'],
  M: ['0', '1', '3', '3.5', '5', '6', '7', '8'],
  L: ['0', '1', '2', '3', '3.5', '4', '5', '6', '7', '8', '9'],
};
active.XL = active.L;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const localTools = join(repoRoot, 'tools/feature-process/node_modules/.bin');
const childOptions = { cwd: repoRoot, env: checkoutEnvironment() };

function checkTree(directory) {
  checkRepoPath(directory, 'directory');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkTree(path);
    else checkRepoPath(path, 'file');
  }
}

function readAssessment(feature) {
  const path = join(feature, expected[0][0]);
  checkRepoPath(path, 'file');
  const text = readFileSync(path, 'utf8');
  const tiers = [...text.matchAll(/^Tier:[ \t]*(.*)$/gm)].map(match => match[1].trim());
  if (tiers.length !== 1 || !Object.hasOwn(active, tiers[0])) {
    throw new Error('Step 0 must declare exactly one Tier: S|M|L|XL line');
  }
  if (!/^Task kind: (feature|bugfix|refactor|tooling|docs|research)(?: \(forced by the caller\))?\r?$/m.test(text)) {
    throw new Error('Complexity assessment must declare an upstream Task kind');
  }
  const changes = [...text.matchAll(/^OpenSpec change:[ \t]*(.*)$/gm)].map(match => match[1].trim());
  return { tier: tiers[0], changes };
}

function openspecJson(args) {
  const child = spawnSync(process.execPath, [join(localTools, 'openspec'), ...args, '--json'], {
    ...childOptions,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.error || child.status !== 0) throw new Error(`OpenSpec ${args[0]} failed (exit ${child.status ?? 'unavailable'})`);
  try {
    return JSON.parse(child.stdout);
  } catch {
    throw new Error(`OpenSpec ${args[0]} returned unreadable JSON`);
  }
}

function checkOpenSpec(change) {
  const openspec = join(repoRoot, 'openspec');
  const changesDir = join(openspec, 'changes');
  const changeRoot = join(changesDir, change);
  checkRepoPath(openspec, 'directory');
  checkRepoPath(changesDir, 'directory');
  checkRepoPath(join(openspec, 'config.yaml'), 'file');
  checkTree(changeRoot);
  if (readdirSync(openspec).includes('specs')) checkTree(join(openspec, 'specs'));

  const status = openspecJson(['status', '--change', change]);
  const home = status?.planningHome;
  if (status?.changeName !== change || status?.root?.path !== repoRoot || status?.changeRoot !== changeRoot ||
      home?.kind !== 'repo' || home.root !== repoRoot || home.changesDir !== changesDir) {
    throw new Error('OpenSpec status did not identify the change in this checkout');
  }
  if (status.isPlanningComplete !== true) throw new Error(`OpenSpec planning is incomplete: ${change}`);

  const validation = openspecJson(['validate', change, '--type', 'change', '--strict']);
  const [item] = validation?.items ?? [];
  if (validation?.root?.path !== repoRoot || validation.items?.length !== 1 ||
      item?.id !== change || item?.type !== 'change' || item?.valid !== true) {
    throw new Error('OpenSpec strict validation did not establish this local change as valid');
  }
}

function artifactsFor(feature, pattern) {
  if (!pattern.includes('*')) return [join(feature, pattern)];
  const [directory, extension] = pattern.split('/*');
  return readdirSync(join(feature, directory), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(extension))
    .map(entry => join(feature, directory, entry.name));
}

function run(command, args) {
  const child = spawnSync(command, args, { ...childOptions, stdio: 'inherit' });
  if (child.error || child.status === null) throw child.error ?? new Error(`${command} interrupted`);
  if (child.status !== 0) {
    process.exitCode = child.status;
    throw new Error(`${command} ${args[0]} exited ${child.status}`);
  }
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { tier: { type: 'string' }, change: { type: 'string' } },
  });
  const [stage, directory] = positionals;
  if (positionals.length !== 2 || !Object.hasOwn(active, values.tier) || !Object.hasOwn(expected, stage)) {
    throw new Error('Usage: run stage <step> features/<slug> --tier S|M|L|XL (Step 6 also requires --change <slug>)');
  }
  const features = join(repoRoot, 'features');
  const feature = resolve(repoRoot, directory);
  const slug = basename(feature);
  if (dirname(feature) !== features || !slugPattern.test(slug)) {
    throw new Error('Feature must be an immediate features/<slug> directory in this checkout');
  }
  checkRepoPath(features, 'directory');
  checkTree(feature);
  const { tier, changes } = readAssessment(feature);
  if (values.tier !== tier) throw new Error(`Tier mismatch: Step 0 declares ${tier}, flag declares ${values.tier}`);
  if (stage !== '10' && !active[tier].includes(stage)) throw new Error(`Step ${stage} is inactive for tier ${tier}`);
  if (stage === '6' && (values.change !== slug || changes.length !== 1 || changes[0] !== slug)) {
    throw new Error('Step 6 requires --change and exactly one Step 0 OpenSpec change line matching the feature slug');
  }

  const expectedPaths = stage === '1' && tier === 'S' ? [] : expected[stage];
  const paths = expectedPaths.flatMap(pattern => {
    const artifacts = artifactsFor(feature, pattern);
    if (artifacts.length === 0) throw new Error(`Missing artifact matching ${pattern}`);
    return artifacts;
  });
  for (const path of paths) {
    checkRepoPath(path, 'file');
    if (!readFileSync(path, 'utf8').trim()) throw new Error(`Empty artifact: ${relative(repoRoot, path)}`);
  }

  if (stage === '6') {
    checkOpenSpec(slug);
    checkoutFiles(['--cached']);
    run(process.execPath, ['.claude/skills/feature-adr/scripts/check-plan-completeness.mjs', feature, `--tier=${tier}`, '--require-requirements']);
  }
  if (stage === '7') {
    run(process.execPath, ['.claude/skills/feature-adr/scripts/check-code-targets.mjs', '--repo', repoRoot, '--feature', feature]);
  }
  if (stage === '8') {
    run(process.execPath, [join(localTools, 'dz'), 'amendment-check', '--feature-dir', feature, '--json']);
    run(process.execPath, [join(localTools, 'dz'), 'claim-check', '--fail-on', 'high', '--json', ...paths]);
    run(process.execPath, ['architecture/guards/check.mjs', '--json']);
  }
  if (stage === '3.5' || stage === '8' || (stage === '6' && tier !== 'S')) {
    run(process.execPath, [
      '.claude/skills/feature-adr/scripts/check-review-convergence.mjs',
      'evaluate', '--repo', repoRoot, '--feature', feature,
      '--phase', stage === '8' ? 'qe' : 'ideation',
    ]);
  }

  console.log(JSON.stringify({
    check: 'stage-artifacts', stage, tier, status: paths.length === 0 ? 'inline' : 'pass',
    ...(stage === '6' ? { change: slug } : {}),
    artifacts: paths.map(path => relative(repoRoot, path)),
  }));
} catch (error) {
  console.error(JSON.stringify({ check: 'stage-artifacts', status: 'not-passed', reason: error.message }));
  process.exitCode ||= 1;
}
