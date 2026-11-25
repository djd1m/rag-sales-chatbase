# План исправления парсеров целей

## Входы и задачи

Inputs read: `00_complexity_assessment.md`, `01_requirements.md`, `check-plan-completeness.mjs`, `expected-target-grammar.mjs`, `check-review-convergence.mjs`, `check-code-targets.mjs` и существующие файлы маршрутов Next.js.

- FR-1 / A1. Сохранить прежние правила формы целевого пути в общем классификаторе рядом с парсером блока. Распознавать динамический синтаксис только у полного каталога маршрута Next.js и только для проверки символов. Передавать исходные строки для сравнения и чтения файлов.
- FR-2 / A2. Применить тот же отказ при недопустимом пути к подготовке нативного снимка. Сохранить диагностику C3 по каждой строке и проверки структурных правил. Добавить положительные прогоны для существующих маршрутов и отрицательные прогоны для недопустимых форм и каталогов.
- FR-3 / A3. Проверить неизменность C8 и C9 на отдельных сценариях и зафиксировать хэши исходной поставки. Прогнать K1 по имени нового тестового модуля и помощника, затем исходный K2 по этому плану до изменения инструментов.

## Amendments

None

EXPECTED_CODE_TARGETS:
- .claude/skills/feature-adr/scripts/check-plan-completeness.mjs
- .claude/skills/feature-adr/scripts/expected-target-grammar.mjs
- tools/feature-process/next-targets.test.mjs
- tools/feature-process/upstream-adaptations.md
