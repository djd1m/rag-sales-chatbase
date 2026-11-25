import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

export function checkoutEnvironment() {
  const env = { ...process.env };
  // Keep direct Node entry points consistent with the run launcher.
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_IMPLICIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE',
    'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  ]) delete env[key];
  return env;
}

export function checkoutFiles(flags) {
  const options = {
    cwd: repoRoot, env: checkoutEnvironment(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], options).trimEnd();
  if (realpathSync(gitRoot) !== repoRoot) throw new Error('Tooling does not belong to the Git checkout root');
  return execFileSync('git', ['ls-files', '-z', ...flags], options).split('\0');
}

export function checkRepoPath(path, kind) {
  const relativePath = relative(repoRoot, path);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Path is outside this checkout');
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`Symbolic link is not allowed: ${relativePath}`);
  }
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`Expected a regular ${kind}: ${relativePath}`);
  }
}
