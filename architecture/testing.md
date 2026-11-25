# Testing & verification (this project)

> feature-adr folds this into Step 8 (QE) as the `testing` role. What it means to be verified HERE.

## Verification commands
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `node architecture/guards/check.mjs --json`
- `tools/feature-process/run openspec validate <change-id> --strict`

## Definition of "done"
Проверяем заявленные сценарии через обычные точки входа и сохраняем фактические команды, exit codes и пропуски. Зависимости, браузер и локальные сервисы запускаем по [воспроизводимому порядку](../docs/REPRODUCE.md). Приёмочные и негативные сценарии перечислены в [BDD](../docs/test-scenarios.md).

## Required gates
- До кода провести K1, K2 и проверки плана из [порядка работы](../tools/feature-process/README.md).
- Для решения с Confirmation выполнить названную проверку. Открытый результат и ограничение окружения указать в QE-артефакте.
