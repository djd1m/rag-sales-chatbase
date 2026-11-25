#!/usr/bin/env python3
"""Проверка комплекта визуального отчёта, не проверка приложения."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
import hashlib
import json
import re
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/ui-ux/chatbase-comparison-2026-11-25').resolve()
assert root.is_dir(), 'Отчёт отсутствует'
errors = []


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ['href', 'src'] and value:
                self.refs.append(value)


def check_link(file, value):
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return
    target = (file.parent / unquote(parsed.path)).resolve()
    if not target.exists():
        errors.append(str(file.relative_to(root)) + ': missing ' + value)


for file in root.rglob('*'):
    if not file.is_file() or file.suffix not in ['.html', '.md']:
        continue
    text = file.read_text()
    parser = References()
    parser.feed(text)
    for value in parser.refs:
        check_link(file, value)
    if file.suffix == '.md':
        for value in re.findall(r'\]\(([^)]+)\)', text):
            check_link(file, value)

manifest = json.loads((root / 'assets-manifest.json').read_text())
for item in manifest:
    file = root / item['file']
    assert file.is_file(), item['file']
    assert hashlib.sha256(file.read_bytes()).hexdigest() == item['sha256'], 'SHA mismatch: ' + item['file']

cards = json.loads((root / 'cards.json').read_text())
assert len(cards) == 9
assert len({c['id'] for c in cards}) == 9
for card in cards:
    for field in ['current', 'reference', 'proposed', 'proposedMobile']:
        assert (root / card[field]).is_file(), card['id'] + ': ' + field
    assert (root / urlsplit(card['prototype']).path).is_file()
    assert card['sources'] and card['currentKind'] and card['referenceKind']
assert (root / 'comparison.pdf').read_bytes().startswith(b'%PDF-')
assert not list(root.rglob('*state*.json')), 'Storage state must never be public'
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print('Report: 9 карточек, ' + str(len(manifest)) + ' изображений; пути и SHA-256 проверены.')
