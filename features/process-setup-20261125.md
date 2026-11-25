# Настройка feature-adr и OpenSpec

25 ноября 2026 (UTC).

## Источники и версии

- Исходный skill из `djd1m/dz-harness`, ревизия `6bd2a460`. Содержимое каталога совпало с поставкой `@dzhechkov/skills-feature-adr` 1.5.26 при сравнении `diff -qr`. [dz-harness](https://github.com/djd1m/dz-harness/tree/6bd2a460)
- Проектный `package-lock.json` фиксирует `dz` 0.8.64, `skills-feature-adr` 1.5.26, OpenSpec 2.2.0, AQE 3.15.23, Node 22.23.4 и TypeScript 5.9.3. Начальная установка на системном Node 20 остановилась в сборке `better-sqlite3`. Повтор на Node 22 установил бинарную зависимость без компилятора. Локальный запуск использует собственный Node из этого lockfile. Инсталляция занимает около 327 МБ.
- В метаданных upstream-skill `agentic_qe_version: 7.5.1` относится к поставке референсов. Исполненный npm/MCP runtime сообщил версию 3.15.23.

## Настройка и проверки

- OpenSpec создан командой `openspec init --tools codex --scope project --profile core`. Установлены семь навыков в `.agents/skills`, их примеры используют закреплённую команду проекта. `openspec list --json` видит корень репозитория, `customer-trust` и `sufler-ui-modernization`. Параметры OpenSpec связаны с каноном и ADR по путям из `openspec/config.yaml`.
- Проектные роли, карта подсистем, guard и протокол delivery сгенерированы `dz feature-adr-setup --from-spec … --guards --gates --target codex --apply`. Повторный `--plan --json` вернул пустой список `missing`. Описания подсистем сверены с npm workspaces, [Architecture](../docs/Architecture.md), [ADR](../docs/ADR.md) и [каноном](../docs/canon.md). Автоматическое обнаружение пакетов у `dz` вернуло пустой список для layout `@n6`, поэтому манифест заполнен по реальным `apps/*` и `packages/*`.
- Upstream K1 `dz name-check` вернул 2 из-за layout. Проектный K1 прочитал 221 TS/JS-файл и 7 манифестов. В проверке известные `build`, `middleware` и `validateModelAnswer` дали коллизии и exit 1, свободные проверочные имена дали exit 0. K2 с `--require-requirements` дал exit 0 для пробы S с корректным планом, exit 1 для той же пробы M без ADR и exit 3 для отсутствующего плана.
- Команда `run stage` проверяет наличие артефактов каждого активного шага. На границах реализации она вызывает upstream K2, строгую OpenSpec-валидацию указанного change, проверку файлов реализации, amendment-check, claim-check и проектный guard. Для ideation и QE используется upstream review convergence. Проба без ADR вернула `not-established` и exit 3. Guard вернул exit 0 и `violations: []`. `claim-check` пропустил нейтральную пробу и отклонил неподтверждённое утверждение о 100% точности с одним `high` и exit 1. Нативный `feature-adr-checkpoint` отклонил запись при отсутствии указанного артефакта с exit 1.
- Паттерны `dz recall` по Суфлёру дали ноль записей. AQE 3.15.23 реально запущен как MCP stdio. `tools/list` вернул 91 инструмент, `fleet_init` вернул `ready`, `memory_query` по `patterns/feature-adr/*` с namespace `learning` вернул success и ноль записей. Команда `run aqe-recall` повторила вызовы из проекта. Отдельный recall по `patterns/feature-adr/qe/*` также выполнился и вернул ноль записей.
- `dz hooks-sync` зарегистрировал два определения в проектном файле и создал исполняемые helper-файлы. В отдельном временном репозитории с `hooks.shellVeto=block` прямой запуск точной команды helper из регистрации на входе `true` вернул 0, а безопасная проба с loopback и nonce вернула 2 и `DZ-VETO`. Sentinel отсутствовал. Запускался helper, сам переданный в JSON shell-текст оставался аргументом проверки.

Свидетельства лежат в `.secrets/feature-process-setup/`. Там есть `project-setup-plan-after.json`, `project-guards.json`, `k1-*.json`, `k2-*.txt`, `checkpoint-refused.json`, `dz-recall.json`, `aqe-mcp-direct.json`, `aqe-recall-wrapper.json`, `hooks-native-check.json` и `hook-helper-veto.json`. Команды для следующего прогона приведены в [README инструментов](../tools/feature-process/README.md).

## Ограничения проверки

- Нативный Codex CLI 0.167.1 сообщил `installed=true`, `executable=true`, `registered=false`, `trusted=false`, `executionVerified=false` и `ready=false`. Причина из диагностики `dz` — отсутствующая или неоднозначная нативная строка регистрации veto. Нативное исполнение остаётся непроверенным до просмотра доверия и хуков в Codex. `codex mcp list --json` в текущем запуске также не обнаружил проектный сервер. Пинованный stdio launcher работает напрямую.
- Результаты проб K1/K2 и AQE подтверждают работу инструментов. Каждый change проходит собственный набор проверок по фактическим входам, включая независимый review, выполнение тестов и фактическую fleet-оценку. Установка AQE с Codex-интеграцией изучена в отдельном каталоге. В репозиторий перенесена проектная MCP-конфигурация с локальной версией вместо `agentic-qe@latest` из генератора.
