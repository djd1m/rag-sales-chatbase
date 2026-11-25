// ── C3 target-path admissibility (P16/D3) — named rules, not one character class ───────────────
// A LEADING DOT is legitimate: `.claude/`, `.github/workflows/ci.yml`, `.gitignore`, `.env.example`
// are ordinary targets in every ecosystem, and until the 2026-08-20 bootstrap fix the `^[\w@]…`
// class rejected every one of them — so feature-adr could not name its OWN files and no feature
// could touch CI config. Found by a run that stopped at this very gate while trying to fix the gate.
//
// This is the HARDENING of that minimal fix, and it answers the three holes it left:
//  (a) the traversal rule was a SUBSTRING test, so an ordinary filename `foo..bar.ts` collected the
//      label `path traversal` (MEASURED). It is replaced by SEGMENT rules: a segment exactly `..` is
//      traversal; a segment of nothing but dots is a DEGENERATE NAME — a different defect that must
//      not borrow the traversal label. Coverage is not weakened: `..`, `../`, `../etc/passwd` and
//      `.a/../b` all carry a `..` SEGMENT and are still refused.
//  (b) a directory-shaped target (`.claude/`) was ACCEPTED and gives Step-6/7 plan-vs-diff matching
//      nothing concrete to verify against — rejected now, by its own name.
//  (c) every refusal names WHAT is wrong. The old catch-all `not a plain repo-relative path` fired
//      for an illegal character, a bad first character and a stray dot alike.
// A named reason that LIES is worse than a generic one: the leading-stem message is emitted ONLY for
// a path that actually starts with a dot, never for `-foo.ts` or `+x.ts`.
const MARKDOWN_RESIDUE_RE = /[*#\[\]()]/;
const LEGAL_TARGET_CHAR_RE = /[A-Za-z0-9_@./-]/;
// Only full directory segments of this project's Next.js App Router are eligible.
// The original path remains the target identity for Git, the filesystem, and reviewers.
const NEXT_ROUTE_DIRECTORY_RE = /^(?:\[(?:\.\.\.)?[A-Za-z_][A-Za-z0-9_]*\]|\[\[\.\.\.[A-Za-z_][A-Za-z0-9_]*\]\])$/;
function maskNextDynamicDirectories(path) {
  if (!path.startsWith('apps/web/src/app/')) return path;
  const segments = path.split('/');
  return segments.map((segment, index) =>
    index < segments.length - 1 && NEXT_ROUTE_DIRECTORY_RE.test(segment) ? '_' : segment,
  ).join('/');
}

function classifyTargetPath(path) {
  const reasons = [];
  const syntax = maskNextDynamicDirectories(path);
  if (/\s/.test(path)) reasons.push('contains whitespace');
  if (MARKDOWN_RESIDUE_RE.test(syntax)) reasons.push('markdown residue');
  if (path.startsWith('/')) reasons.push('absolute path — targets are repo-relative');
  if (path.startsWith('~')) reasons.push('home-relative path — targets are repo-relative');
  const anchoredHere = path === '.' || path.startsWith('./');
  if (anchoredHere) reasons.push('not repo-relative (anchored at the current directory)');
  const segs = path.split('/');
  let dotDot = false, degenerate = false, emptySeg = false, trailingDotSeg = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === '..') { dotDot = true; continue; }
    if (/^\.+$/.test(s)) { if (s.length >= 3 || (i > 0 && !anchoredHere)) degenerate = true; continue; }
    if (s === '') { if (i > 0 && i < segs.length - 1) emptySeg = true; continue; }
    if (s.endsWith('.')) trailingDotSeg = true;
  }
  if (dotDot) reasons.push("path traversal ('..' segment)");
  if (degenerate) reasons.push('degenerate path segment');
  if (emptySeg) reasons.push('empty path segment');
  if (path.endsWith('/')) reasons.push('trailing slash — names a directory, not a file');
  if (trailingDotSeg) reasons.push("path segment ends with '.'");
  // Residual character check — LAST, and it names the first offender instead of shrugging. Characters
  // already explained by the whitespace/markdown rules are skipped so one defect gets one reason.
  const scanned = syntax.startsWith('~') ? syntax.slice(1) : syntax;
  const illegal = [...scanned].find((c) => !LEGAL_TARGET_CHAR_RE.test(c) && !/\s/.test(c) && !MARKDOWN_RESIDUE_RE.test(c));
  if (illegal !== undefined) reasons.push(`illegal character '${illegal}'`);
  // The leading stem: a dot must be followed by a REAL name (`.-` has an empty stem), and any other
  // path must start with a word character, '@' or '.'. Suppressed where a structural rule above
  // already explains the first character, so the operator is never handed a reason that is false.
  else if (!/^\.?[\w@]/.test(path) && !path.startsWith('/') && !path.startsWith('~') && !anchoredHere && !dotDot && !degenerate) {
    reasons.push(path.startsWith('.') ? 'empty stem after the leading dot' : "path does not start with a letter, digit, '_', '@' or '.'");
  }
  return reasons;
}

/** Raw-text trailing declaration grammar and literal path syntax. */
export function parseExpectedTargetBlock(text) {
  const lines = String(text || '').split('\n');
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^EXPECTED_CODE_TARGETS:[ \t]*\r?$/.exec(lines[i]);
    if (match && match[0] === lines[i]) markers.push(i);
  }
  const startLine = markers.length ? markers[0] : -1;
  if (markers.length !== 1) return { ok: false, targets: [], startLine, reason: 'target-block-missing-or-duplicate' };
  if (lines.slice(startLine).some(line => line.includes('\r'))) return { ok: false, targets: [], startLine, reason: 'target-block-malformed' };
  const targets = [];
  for (const line of lines.slice(startLine + 1)) {
    if (!line.trim()) continue;
    const match = /^- (.+)$/.exec(line);
    // Full-line equality also refuses a final U+2028/U+2029 that $ can match before.
    if (!match || match[0] !== line) return { ok: false, targets: [], startLine, reason: 'target-block-malformed' };
    targets.push(match[1]);
  }
  if (!targets.length) return { ok: false, targets: [], startLine, reason: 'target-block-empty' };
  const rejected = [];
  for (const path of targets) {
    const reasons = classifyTargetPath(path);
    if (reasons.length) rejected.push({ path, reasons });
  }
  if (rejected.length) return { ok: false, targets: [], startLine, reason: 'target-path-invalid', rejected };
  return { ok: true, targets, startLine };
}
