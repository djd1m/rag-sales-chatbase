# Step 8 — независимая проверка итоговой реализации

Нативный цикл **2 закрыт** установленным CLI: `closed`, exit 0, нет unresolved/reasons. Ревизия `fdfd0b4a6f57b96e9d71888987797b6bea7ee6732f63dd4dacbad12591a5017b`, nonce `9ce3fe4b-5c25-4d5c-8562-46ab150ab268`. Первая unresolved-история и отдельные неуспешные попытки сохранены; ничего не сбрасывалось. Это завершение локального QE, выпуск ещё ожидает Step 9 и проверки последующих OpenSpec-метаданных.

QE-VERDICT: A-

## Primary QE pass

Оригинальная роль `qe-primary`, семейство Codex: **A-**, current clean. Все свои три исходных условия сохранены дословно и проверены на текущей ревизии. Проверены авторская structural delta, фактические источники и результаты. Для UI первоначальная трактовка исследования с пятью людьми как условия до выпуска отозвана самой исходной ролью по FR-5 и ADR; сессий, согласованного порога или одобрения сроков владельцем не было.

## Precision QE pass

Оригинальная роль `qe-precision`, семейство Codex: **A-**, current clean. Все три своих исходных условия сохранены; проверены неизменённые UI-источники, тарифные значения, отдельные реальные U09/AM9/AM10 и границы новых компонентных Chromium-случаев. Перекрёстная проверка использовала исходные роли; это cross-model, без заявления о cross-family Claude-проверке. Учётная запись Claude была недоступна. Автоматическое выполнение Codex hooks не установлено; явно выполненные проверки не подменяются таким утверждением.

## Combined Step-8 grade

**A-** — консервативная минимальная фактическая оценка исходных ролей. Исходные условия 6/6 закрыты текущими собственными верификациями; нового подтверждённого блокирующего дефекта продукта нет. Оценка относится к локальному контуру и указанным границам, не к настоящей работе ещё не включённых поставщиков.

## Проверенные результаты

- Полный актуальный набор на точном образе r6 с read-only тестовым снимком `03a69c9` и отдельными PostgreSQL/Redis: **1280/1280**, 77 файлов, 0 skips, 211,72 с; test/cleanup exit 0. Прежний образный набор 1263/1263 сохранён отдельно.
- Default-route/SSR **15/15**, полный SQL billing **23/23**, тестовые типы и lint прошли. Новый планировщик — **5/5**, независимый one-wake mutant RED и исправленный helper GREEN.
- Расширенные **18/18** — настоящие Chromium React-компонентные fixtures с SSR/hydration, navigation shim и synthetic API, **не реальные Next routes**. Прежние 321 компонентный и 30 targeted stand-случаев имеют отдельную область; число не выдаётся за 351 полный Next E2E. Галерея и реальный U09 относятся к r4 с неизменёнными UI-источниками.
- Новый шестисторонний нагрузочный прогон: actual exit 0, analysisVersion 3, ok true, 4824 raw lag положительны, 299 источников/606 runtime/3 файла стенда не менялись. RAG p95 median 213,883 мс при пределе 323,488; индексация 1394 мс при пределе 3578. [Измерения и сохранённые FAIL](../customer-trust/07_code_changes/load-validation.md).
- Наблюдаемое добавленное покрытие: нижняя граница 94,28%; все фиксированные критические файлы ≥90%. Для 54 существующих файлов одинаковая калибровка дала 82,31% baseline и 90,27% current. Точное универсальное покрытие, причинность при разных корпусах и неинструментированные пути не установлены. [Метод и пределы](../customer-trust/07_code_changes/coverage-validation.md).
- Реальная скомпилированная Next-граница оплаты проверена искусственным HTTP: typed 503 с исходным intent и same-key 201; cold cut-off — typed 409, ноль POST, тот же intent/snapshot/first dispatch. [Граница исполнения](../customer-trust/07_code_changes/runtime-boundary-validation.md).

## ADR Fitness Checklist

| ADR | Fitness в локальном контуре | Confirmation и границы |
| --- | --- | --- |
| ADR-001 | PASS | Safe next, preview idempotency, claim/session authority и явный PDF-переход в `tests/preview-intent.test.ts`/source-journey/recovery. |
| ADR-002 | PASS | Темы/viewport/axe/keyboard, реальные source-journey U09 и отдельные компонентные recovery cases. Это не пять пользовательских сессий и не полный аудит screen reader. |

## Локальная приёмка и сохранившиеся границы

Все локальные FR имеют цепочки к ADR, задачам, исходникам и наблюдённым тестам; итоговый пересчёт и гранулярные ограничения подтверждаются отдельно в Step 9. Цены, квоты, модели и срок оплаты сохранены. Новые Resend, оплата/чеки и Libredesk выключены до ключей и активационных проверок. Отсутствующие агрегаты возраста/результата outbox записаны как наблюдаемостный follow-up до включения, а не как выполненная телеметрия.

## Findings ledger

| Finding | Severity | Status | Round | Author | Title |
|---------|----------|--------|-------|--------|-------|
| UI-PRECISION-01 | HIGH | fixed | 1 | codex | Actual route/U09 evidence and scoped synthetic boundaries |
| UI-PRECISION-02 | HIGH | fixed | 1 | codex | Runtime tariff ceilings and CTA |
| UI-PRECISION-03 | MEDIUM | named-limit | 1 | codex | Human study explicitly unperformed and separate |
| UI-PRIMARY-01 | HIGH | fixed | 1 | codex | Real stand, U09 and scoped browser evidence |
| UI-PRIMARY-02 | MEDIUM | refuted | 1 | codex | Retracted pre-release human-study interpretation; no study claimed |
| UI-PRIMARY-03 | HIGH | fixed | 1 | codex | Actual pinned amendment gate provenance |
| PROCESS-GUARD-01 | HIGH | refuted | 2 | codex | Preexisting canonical-delegating adapter is not a stale skill implementation; raw generic guard still blocks |
| INSTALL-SPACING | LOW | named-limit | 2 | codex | Existing manual-copy hint spacing; tested fallback remains usable |
| BROWSER-SCOPE | INFO | named-limit | 2 | lead | Chromium fixtures are distinct from real Next routes and human research |

Историческое `WARNING` отображено как `MEDIUM` только для закрытого словаря этой таблицы; исходные объекты условий host не менялись. У оставшихся `named-limit` нет скрытого заявления о выполненной внешней интеграции или исследовании.

## Точность общих инструментов

Общий `dz guard check --op code` **реально вернул HARD block** `no-skill-drift`; `signature-fresh` — `notEstablished`. Он не объявляется пройденным. Исходная независимая роль воспроизвела тот же результат на базовом `ba39597`: `.agents/skills/feature-adr/SKILL.md` — намеренный единственный файл-адаптер, явно загружающий `.claude` canonical/shard/toolchain, а не устаревшая копия реализации. Basename-эвристика сравнила разные назначения и показала те же 114 различий/113 отсутствующих файлов, zero canonical defects. HIGH зарегистрирован и независимо refuted как дефект продукта/рассинхронизация исполняемых gates; конфигурация и результаты guard не менялись, исключение не добавлялось. Потребитель, напрямую требующий сырой guard exit 0, остаётся заблокирован этим инструментом. Проектный Step-8 gate использует реальные amendment/claim-check/architecture/convergence; их результаты фиксируются отдельно.

## QE cost ledger

Свежая проверка, не восстановление из matching QE checkpoint; фактический результат writer добавлен ниже без `--auto`. Точная модель reviewer не установлена — поле будет null, семейство Codex известно. Метрики считают строки Findings ledger, а не выдуманные новые ошибки.

```json
{"ok":true,"kind":"ledger","stage":"qe","verdict":"written","exit":0,"reason":"appended and verified by re-reading the tail","blocking":false,"target":"/home/rag-sales-chatbase/.dz/feature-adr/run-cost-ledger.jsonl"}
```

## Наблюдённый learning loop

В текущем recall получено 0 подходящих записей dz и 0 AQE learning patterns. После закрытия gap loop сохранён один урок о повторной проверке абсолютного монотонного дедлайна: собственный bounded confidence 0,9 опирается на независимый RED/GREEN и новые 4824 точки, а не обещает все платформы. AQE MCP подтвердил KV store и query 1; semantic vector index недоступен, его успех не заявляется. Тот же текст отдельно записан через dz teach и перечитан отдельным recall. Начальная попытка private helper использовала неправильный Node PATH, сохранена как отказ; повтор с закреплённым Node выполнился без переустановки пакетов.

Механический поиск unfinished-маркеров в 147 изменённых product/scripts/tests путях не обнаружил совпадений. Реальный project architecture guard прошёл; общий monorepo guard и его пределы описаны выше отдельно.
