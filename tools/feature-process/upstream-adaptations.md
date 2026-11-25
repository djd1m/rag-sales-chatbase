# Проектные адаптации feature-adr

## Буквальные цели в динамических маршрутах Next.js

Исходная поставка `@dzhechkov/skills-feature-adr@1.5.26` совпала с локальной копией до правки по следующим SHA-256. Ревизия skill при первоначальной установке `6bd2a460`. [dz-harness](https://github.com/djd1m/dz-harness/tree/6bd2a460)

| Путь относительно `.claude/skills/feature-adr/scripts/` | SHA-256 поставки до адаптации |
|---|---|
| `check-plan-completeness.mjs` | `1c8f8e6ffad01ebdb1bcf6fce6cfb6baae6fe40a9ce377b3894f8addc06c8180` |
| `expected-target-grammar.mjs` | `e763efd3af9c7ba71f758f6d6c349b21f2a41ded0420fc165269eab82b6433fb` |

Единая проверка синтаксиса используется C3 и нативным читателем `EXPECTED_CODE_TARGETS` в проектных скриптах. Полные сегменты `[name]`, `[...name]` и `[[...name]]` разрешены перед последующим сегментом пути только под `apps/web/src/app/`, если `name` соответствует `[A-Za-z_][A-Za-z0-9_]*`. Исходное написание возвращается из парсера и используется для проверки файлов, поиска идентичных копий и измерения снимка. При ошибке синтаксиса блок целиком отклоняется. Проверка нативного снимка по-прежнему читает пути как конкретные файлы и проверяет границы checkout.

Адаптация покрывает текущий Plain-процесс через `run k2`, `check-code-targets.mjs` и локальный review convergence. Отдельный читатель целей и polling barrier в установленном `@dzhechkov/harness-core` по-прежнему отвергает скобки. Этот путь остаётся ограничением при переходе на автоматизированный Workflow.

Регрессии запускаются командой `tools/feature-process/node_modules/.bin/node --test tools/feature-process/next-targets.test.mjs`. Тесты покрывают строгую форму декларации, исходные пути, нативное измерение и отказы C3, C8 и C9. [Отчёт о прогонах](../../features/process-next-targets/08_qe_report.md)
