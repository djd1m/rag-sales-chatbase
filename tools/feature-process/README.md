# Проверки feature-adr и OpenSpec

В каталоге закреплены `dz` 0.8.64, `skills-feature-adr` 1.5.26, OpenSpec 2.2.0, `agentic-qe` 3.15.23 и Node 22.23.4. Для первой установки нужен Node 22.20 или новее и npm 10 или новее. Команды запускаются из корня проекта через локальный Node.

```bash
npm ci --prefix tools/feature-process
tools/feature-process/run dz --version
tools/feature-process/run openspec --version
tools/feature-process/run aqe --version
```

## Порядок работы

- Протокол и модули в `.claude/skills/feature-adr/`, проектные роли в `architecture/project-skills.json`. Для каждого активного шага проверить артефакты с помощью `tools/feature-process/run stage <step> features/<slug> --tier L`. Указать в `00_complexity_assessment.md` отдельную строку `Tier: L` с фактическим tier. Команда сверяет его с флагом и читает только канонический `features/<slug>` этого checkout с обычными файлами и каталогами. Ревью, эксперименты и решение владельца фиксируются отдельно по фактическим свидетельствам.
- Обновлять состояние на старте каждого шага через `tools/feature-process/run dz statusline --fa-record --slug <slug> --run-id <run-id> --tier L --step 'Step 0' --recalled 0 --stored 0 --mode direct`. Вносить реальные счётчики и актуальное имя шага. `dz recall --json --limit 5` и при необходимости `aqe-recall` выполняются отдельно. Хранилище `dz` для recall и явно принятого teach должно быть одним и тем же.
- В OpenSpec указать ID change и связать требования и сценарии с ADR, задачами и проверками. Рабочие команды `tools/feature-process/run openspec status --change <id> --json` и `tools/feature-process/run openspec validate <id> --type change --strict --json`.
- Перед независимым ревью запустить `tools/feature-process/run convergence prepare --repo "$PWD" --feature features/<slug> --phase <ideation|qe> --reviewers "$actual_reviewers"`. Передать реальные роли, семейства моделей и независимые заключения по формату из `03.5-ideation-swarm.md` и `08-qe.md`. Проверка этапов 3.5, 6 для M+ и 8 вызывает `convergence evaluate`. Новые байты в измеряемом артефакте требуют актуальной проверки рецензентами.

### До кода

1. Проверить все вводимые имена по списку из плана. `tools/feature-process/run dz name-check --module <basename> --export <a,b> --json` поддерживает layout `packages/@dzhechkov/*/src/`, поэтому для структуры Суфлёра возвращает exit 2. Обязательная проверка здесь `tools/feature-process/run k1 --module <basename> --export <a,b>`. Флаг `--command` проверяет имена npm scripts. Она читает рабочие версии отслеживаемых и новых неигнорируемых TS/JS-файлов в `apps/` и `packages/`, а также их `package.json` и корневой `package.json`. Проверяет basename модулей и именованные экспорты. Внешние звёздочные реэкспорты и динамический CommonJS проверяются при сборке. Exit 0 означает свободные имена в этой области, 1 означает коллизии, 2 означает неопределённый результат. Применять проверку перед созданием файлов и сохранить вывод.
2. Записать в Step 0 отдельную строку `OpenSpec change: <slug>` и запустить `tools/feature-process/run stage 6 features/<slug> --tier L --change <slug>`. Команда сверяет ID со slug и локальным корнем OpenSpec, требует `isPlanningComplete: true`, выполняет строгую валидацию и вызывает оригинальный K2 с `--require-requirements`. Для диагностики K2 отдельно использовать `tools/feature-process/run k2 <каталог-фичи> --tier=L`.
3. Запустить `tools/feature-process/run dz challenge --plan features/<slug>/06_implementation_plan.md --author <planner-model>` для брифа независимому рецензенту. Зафиксировать фактический вердикт и поправки.

### После кода

- `run stage 7` вызывает upstream `check-code-targets.mjs` и проверяет наличие манифеста изменений. `run stage 8` выполняет `dz amendment-check`, `dz claim-check --fail-on high` для QE-отчёта и проектный guard. Названные тесты и проверку их различающей способности выполнять по модулю `08-qe.md`. `dz discrimination-check --slug <slug> --base <pre-change-ref> --json` поддерживает ограниченный набор раннеров, поэтому состояние результата следует читать из JSON.
- Артефакт Step 9 обязателен для L/XL. Использовать фактическое независимое QE и сценарии из плана. При opt-in Step 10 выполнить протокол в [architecture/gates/delivery-check.md](../../architecture/gates/delivery-check.md).
- `node architecture/guards/check.mjs --json` по списку Git проверяет публикуемые файлы, включая feature-артефакты, OpenSpec, конфигурацию Codex и шаблоны `.env`. Локальные `.env`, приватные каталоги и генерируемое состояние исключены. Недоступный обязательный файл вызывает отказ. Для нарушений выводятся путь и правило.
- Для durable checkpoint запускать `tools/feature-process/run dz feature-adr-checkpoint --slug <slug> --stage <router|design|plan|code|qe|fleet> --input-hash "$input_hash" --result "$observed_result" --artifact "$actual_artifacts" --json`. Хэш привязать к фактическим входам, `--artifact` содержит имена файлов относительно `features/<slug>` через запятую. Отсутствующий файл приводит к отказу записи. Состояние, usage receipts и свидетельства проверок сохраняются по реальным результатам.

## AQE и хуки Codex

`tools/feature-process/run aqe-recall 'patterns/feature-adr/*'` запускает локальный MCP stdio, инициализирует fleet и вызывает `memory_query` в `learning`. При повторном запуске локальный in-memory сервер начинает новую сессию. Для одной продолжающейся сессии использовать зарегистрированный сервер из `.codex/config.toml` после загрузки проектной конфигурации. `fleet_init` и `memory_query` подтверждают работу инструментов и recall, а оценка фичи проводится на её собственных артефактах и тестах. Отдельный долговременный store используется только через принятый `dz teach`.

Локальная регистрация использует абсолютные пути, поэтому каждый checkout генерирует свои файлы. Команды сохраняют прочие записи проектной регистрации.

```bash
tools/feature-process/run dz hooks-sync --target codex --scope project --no-verify --json
tools/feature-process/run dz hooks-sync --target codex --scope project --check --no-verify --json
```

`installed`, `executable`, `registered`, `trusted` и `executionVerified` проверяются отдельно. Для нативной проверки открыть проект в Codex, просмотреть доверие рабочей папке и оба определения хуков через интерфейс Codex, затем запустить `tools/feature-process/run dz hooks-sync --target codex --scope project --verify --json`. Включать `hooks.shellVeto = "block"` в `.dz/config.json` для политики блокировки только по решению владельца проекта. По умолчанию upstream использует `warn` для shell veto. Обычный вывод smoke-теста helper и машинный verdict нативного Codex хранятся отдельно.

Вендорные QE references сохраняются побайтно по upstream manifest, включая исходные CRLF и завершающие пробелы. `.gitattributes` исключает только этот каталог из whitespace lint; проектный код и авторские документы проверяются обычно.

Для Gitleaks добавлено одно rule/path/value исключение синтетического `API_KEY` из upstream eval `tc005_hardcoded_credentials` (security-testing.yaml); это учебный тест поиска зашитых ключей. Значение не совпадает с конфигурацией VPS. Реальные ключи и остальные файлы этим исключением не покрываются.
