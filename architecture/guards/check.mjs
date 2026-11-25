#!/usr/bin/env node
// Project adaptation of the deterministic guard scaffold from dz feature-adr-setup.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { checkoutFiles, checkRepoPath, repoRoot } from '../../tools/feature-process/repo-paths.mjs';

const configPath = 'architecture/guards/guards.config.json';
const privateDirectories = new Set(['.git', '.secrets', 'secrets', 'credentials', '.auth', '.dz', '.agentic-qe', '.fa-state']);
const secrets = [
  ['private-key-pem', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['stripe-key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
const violations = [];
let scanned = 0;

function report(rule, path) {
  violations.push({ rule, path });
}

function publicPath(path) {
  if (!path || path.split('/').some(part => privateDirectories.has(part))) return false;
  if (path === '.codex/hooks.json' || path.startsWith('.codex/dz-hooks/')) return false;
  const name = basename(path);
  return name !== '.env' && (!name.startsWith('.env.') || /\.(?:example|sample|template)$/.test(name));
}

function read(path) {
  const fullPath = resolve(repoRoot, path);
  checkRepoPath(fullPath, 'file');
  return readFileSync(fullPath);
}

function applyWaiver(waivers, rule, path) {
  const waiver = waivers?.find(candidate => candidate?.path === path);
  if (!waiver) report(rule, path);
  else if (typeof waiver.reason !== 'string' || !waiver.reason.trim()) report('waiver-without-reason', path);
}

function scan(config, candidates, deleted) {
  const required = new Set([configPath, ...config.secretScan.required]);
  const pins = new Map((config.frozenFiles ?? []).map(pin => [pin.path, pin.sha256]));
  for (const path of [...required, ...pins.keys()]) {
    if (!candidates.has(path)) report('required-input-unavailable', path);
  }

  for (const path of candidates) {
    if (deleted.has(path) && !required.has(path) && !pins.has(path)) continue;
    let bytes;
    try {
      bytes = read(path);
    } catch {
      report('input-unavailable', path);
      continue;
    }
    if (pins.has(path) && createHash('sha256').update(bytes).digest('hex') !== pins.get(path)) {
      report('frozen-file', path);
    }
    const textConfig = /\.(?:ya?ml|json|toml)$/i.test(path) || basename(path).startsWith('.env.');
    if (!textConfig && bytes.includes(0)) continue;

    scanned++;
    const text = bytes.toString('utf8');
    for (const [type, pattern] of secrets) {
      if (pattern.test(text)) applyWaiver(config.secretScan.waivers, `secret-scan/${type}`, path);
    }

    const loc = config.locCap;
    if (loc?.limit > 0 && loc.include.some(prefix => path.startsWith(`${prefix.split('/**')[0]}/`)) &&
        (!loc.extensions?.length || loc.extensions.includes(extname(path))) && text.split('\n').length > loc.limit) {
      applyWaiver(loc.waivers, 'loc-cap', path);
    }
  }
}

try {
  const candidates = new Set(checkoutFiles(['--cached', '--others', '--exclude-standard']).filter(publicPath));
  if (!candidates.has(configPath)) {
    report('required-input-unavailable', configPath);
  } else {
    const config = JSON.parse(read(configPath).toString('utf8'));
    const deleted = new Set(checkoutFiles(['--deleted']));
    scan(config, candidates, deleted);
  }
} catch {
  report('scan-unavailable', configPath);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: violations.length === 0, scanned, violations }));
} else if (violations.length === 0) {
  console.log(`guards: checked ${scanned} files`);
} else {
  for (const { rule, path } of violations) console.log(`[${rule}] ${JSON.stringify(path)}`);
}
process.exitCode = violations.length === 0 ? 0 : 1;
