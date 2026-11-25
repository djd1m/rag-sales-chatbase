import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { checkoutFiles, checkRepoPath, repoRoot } from './repo-paths.mjs';

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const workspaceFile = /^(?:apps|packages)\/[^/]+\//;

function remember(store, name, path) {
  if (!name) return;
  if (!store.has(name)) store.set(name, []);
  store.get(name).push(path);
}

function collectBindings(node, names) {
  if (ts.isIdentifier(node)) {
    names.push(node.text);
  } else {
    for (const element of node.elements) {
      if (ts.isBindingElement(element)) collectBindings(element.name, names);
    }
  }
}

function exportedNames(code, path) {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, false);
  if (source.parseDiagnostics.length > 0) throw new Error(`Cannot parse ${path}`);

  const names = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      const clause = statement.exportClause;
      if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.push(element.name.text);
      } else {
        names.push(clause.name.text);
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindings(declaration.name, names);
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function scan() {
  const paths = checkoutFiles(['--cached', '--others', '--exclude-standard']);
  const facts = {
    command: new Map(),
    module: new Map(),
    export: new Map(),
    manifests: 0,
    sources: 0,
  };

  for (const path of new Set(paths)) {
    const manifest = path === 'package.json' || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path);
    const source = workspaceFile.test(path) && sourceExtension.test(path);
    if (!manifest && !source) continue;
    const absolute = resolve(repoRoot, path);
    try {
      checkRepoPath(absolute, 'file');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const code = readFileSync(absolute, 'utf8');
    if (manifest) {
      facts.manifests++;
      for (const name of Object.keys(JSON.parse(code).scripts ?? {})) remember(facts.command, name, path);
    } else {
      facts.sources++;
      remember(facts.module, basename(path).replace(sourceExtension, ''), path);
      for (const name of new Set(exportedNames(code, path))) remember(facts.export, name, path);
    }
  }
  return facts;
}

try {
  const { values } = parseArgs({
    options: {
      command: { type: 'string', multiple: true },
      module: { type: 'string', multiple: true },
      export: { type: 'string', multiple: true },
    },
  });
  const checks = ['command', 'module', 'export'].flatMap(kind =>
    (values[kind] ?? []).flatMap(list => list.split(',').map(name => ({ kind, name: name.trim() }))),
  );
  if (checks.length === 0 || checks.some(({ name }) => !name)) {
    throw new Error('Supply at least one nonempty --command, --module or --export name');
  }

  const facts = scan();
  for (const { kind } of checks) {
    if ((kind === 'command' ? facts.manifests : facts.sources) === 0) {
      throw new Error(`No workspace inputs scanned for ${kind}`);
    }
  }
  const collisions = checks.flatMap(({ kind, name }) =>
    facts[kind].has(name) ? [{ kind, name, paths: facts[kind].get(name) }] : [],
  );
  console.log(JSON.stringify({
    checker: 'sufler-workspace-source',
    status: collisions.length === 0 ? 'pass' : 'fail',
    scanned: { manifests: facts.manifests, sources: facts.sources },
    checks,
    collisions,
  }, null, 2));
  process.exitCode = collisions.length === 0 ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({
    checker: 'sufler-workspace-source', status: 'not-established', reason: error.message,
  }));
  process.exitCode = 2;
}
