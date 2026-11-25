# Владение файлами и детальные задачи customer-trust

Обязательное дополнение к [Step 6](06_implementation_plan.md), прочитать до кода наряду с [интерфейсами](06_interfaces.md). Эта детализация сохраняет прежние решения, границы и проверочные ручьи полного плана.

## Goal state

Run ID `sufler-trust-20261125-1`, tier XL. Входная ревизия независимого QCSD `3bdcaeed42340b3ee1f8050f3a132f453ae8ad24787d4ac5c489498753b70283`, все 12 условий закрыты в проекте. Планирование выполнено по локальному SPARC-GOAP reference. Текущий checkout сохраняет работающие login/preview/partner, внутреннюю карту оплаты, erasure, RAG и worker. Локальные fake остаются источником испытательных фактов. Процент покрытия исходной версии не измерен.

| Состояние | Критерий перехода |
| --- | --- |
| S0, specification | FR-1–FR-10, NFR-1–NFR-5, C-1–C-4, ADR-001–003 и OpenSpec задают цели. |
| S1, pseudocode | Отдельно записаны допуск новой покупки, фактическое потребление доказательства, `lease → dispatch commit → HTTP → CAS`, закрытие старых виджетов и локальная граница стирания. |
| S2, architecture | Один владелец файла, договор `@n6/notifications`, миграции 016/017, новое дерево Next routes и собственный проверочный контур. K1/K2 дают исполняемые свидетельства. |
| S3, refinement | Для A1–A8 и исходных 12 условий есть наблюдаемые отрицательные и успешные сценарии. Направления auth/DB, payment/support и интеграция оказывают только согласованные эффекты. |
| S4, completion | Полная сборка, локальные e2e, парный нагрузочный прогон, независимое QE и проверенные артефакты. Продакшен и реальная активация ждут ключей и самостоятельных свидетельств. |

Цель локальной поставки — 100% MUST и Confirmation assertions с проверяемым результатом, сохранение штатных путей и отрицательных сценариев. Массовые проценты покрытия и работа реального провайдера не выводятся из локальных тестов.

## Tasks

### TASK-1: Закрепить интерфейс транспорта, настройку и границы модулей — ADR-001, ADR-002, ADR-003, NFR-2, NFR-5, C-2, C-3, C-4

SPARC specification/architecture. Корневой интегратор, до 45 мин. Зависимости: закрытый QCSD. Зафиксировать формы ниже, номера миграций, владение файлами и OpenSpec. Проверить K1 на фактических именах и K2 на завершённом плане. Ни один автор кода не запускается до допуска Step 6.

### TASK-2: Реализовать общий транспорт и тексты транзакционных писем — ADR-001, ADR-002, FR-3, FR-4, FR-10, NFR-1, NFR-2, NFR-5, C-3

SPARC refinement. Автор 1, 60–90 мин. Зависит от TASK-1 и workspace-заготовки TASK-9. `packages/notifications/{tsconfig.json,src/index.ts,src/customer-mail-settings.ts,src/customer-resend-transport.ts,src/customer-mail-templates.ts}`. Изолированный transport-интерфейс, 5 с, 16 КиБ, 2 одновременных запроса на web-процесс, фиксированный Resend HTTPS, `redirect:error`, минимальная диагностика. Проверить `tests/customer-trust-auth.unit.test.ts` — `mail transport bounds time and response bytes without exposing secrets`. Сначала отказ без тела, большой поток и неизвестный результат воспроизводятся fake; итог различает HTTP acceptance, retryable, permanent и unknown. A8.

### TASK-3: Записать доказательства email и принятие документов, подключить auth-контракты — ADR-001, ADR-003, FR-2, FR-3, FR-4, FR-5, NFR-1, NFR-2, NFR-3, C-4

SPARC pseudocode/refinement. Автор 1, 2–3 ч. Зависит от TASK-1/2, корневой конфигурации TASK-9 для runtime-прогона. `packages/db/migrations/016_customer_trust_identity_legal.sql`, `packages/db/src/{partners.ts,customer-email-proof.ts}`. Вход `apps/web/src/server/{auth.ts,auth-store.ts,auth-handler.ts,route.ts,customer-email-actions.ts,preview-claim-context.ts}` и четыре новых `api/auth` маршрута. Существующие `register/login/logout/route.ts` используют `authRoute`. Signup сравнивает раздельные `terms:{accepted,version}` и `consent:{accepted,version}`, пишет серверные digest/time вместе с аккаунтом/сессией/атрибуцией. Недействительный следующий адрес, занятой аккаунт или проигравшая гонка ничего не добавляют от чужого имени. Verify хранит только digest кандидата и прежний proof до `accepted`, reset проверяет цель/current email и атомарно отзывает ссылки и сессии. Forgot 202 одинаков по status/body, фон в памяти без долговременной ссылки. A1/A6/A8.

Test: `tests/customer-trust-auth.integration.test.ts` (три утверждения из Confirmation) и `tests/customer-trust-legal.integration.test.ts` — `registration records two current legal versions only for the actual new account`. Адаптировать ожидания строгого публичного signup в `tests/auth.test.ts`, `tests/preview-flow.integration.test.ts`, `tests/partners.unit.test.ts`, `tests/public-page.unit.test.ts`, сохраняя прежние проверки. Прямые SQL-фикстуры сохраняют форму. На V1→V2, повторе и ошибке записи проверять отсутствие частичных эффектов.

### TASK-4: Доставить публичные документы и пользовательские состояния входа — ADR-001, ADR-003, FR-1, FR-2, FR-3, FR-4, FR-5, NFR-1, NFR-4, C-1, C-4

SPARC refinement. Автор 1, 2–3 ч. Зависит от TASK-1/3, для виджета — TASK-9. `apps/web/src/lib/trust-legal-catalog.ts`, legal pages, `TrustLegalDocument.tsx`, `trust-legal-document.module.css`, `login/AuthForm.tsx` и `login/page.tsx`, recover pages/shared component, `apps/web/src/lib/payment-return.ts`. Версии опубликованных текстов явные, подтверждённые реквизиты из pinned Clipmkr. Условия, оферта 990/4900 ₽ разово на 30 дней, privacy, consent, cookies описывают реальные процедуры и раскрытие виджета. Второй браузер сначала входит и вновь открывает исходное письмо, фрагмент только в памяти. `safeNextPath` принимает PDF ровно `/dashboard?source=pdf`, старые purchase/invite остаются. Контекст preview из валидного сессионного заголовка, одноразовый tab-local hint 2 мин. Представление результата платежа в существующем `payment-return.ts` меняет только этот автор по контракту TASK-5, чтобы избежать двойного владения.

Test: `tests/browser/customer-trust-auth.test.ts`, `tests/browser/customer-trust-legal.test.ts` — `public documents and visitor notice expose the approved Sufler terms and contacts`, обновить `tests/browser/partners.test.ts` для реальных чекбоксов и строгого payload. `tests/browser/design-shell.test.ts` сохраняет единственного UI writer, здесь используется как интеграционная регрессия. Проверить назначение origin, 390/1440, клавиатуру, no-cache/referrer, fragment GET/POST, 72 байта UTF-8 и видимость пароля. A6/A8.

### TASK-5: Применить оплату к одному разрешённому намерению — ADR-002, FR-6, FR-7, FR-8, NFR-1, NFR-3, NFR-4, NFR-5, C-1, C-3

SPARC pseudocode/refinement. Автор 2, 2–4 ч. Зависит от TASK-1 и интерфейса 016 из TASK-3, merge/refinement после TASK-3/4. `packages/db/migrations/017_customer_trust_billing.sql`, `packages/db/src/payments.ts`, `apps/web/src/server/billing-{deps,handler,runtime}.ts`, `payments/{config,provider,yookassa}.ts`, существующие upgrade screens/pages и API checkout. Новый intent проверяет `offer_version`, `email_verified_at`, доверенную сессию и цену; чистый сериализованный снимок, отметка допуска перед POST и guard lower→higher. Старые intent проверяются без ретроактивных снимков и отправок. Ключ и тело неизменны, `verification`/`reconciliation`/`succeeded` выводятся на факте данного intent, active plan не маскирует сверку. Новый снимок принимает только explicit `full_payment` и подтверждённое окружение. Повтор сохраняет bound GET, webhook сверяет IP, проект, режим, ID, сумму и ссылку на intent.

Test: `tests/customer-trust-billing.integration.test.ts` (четыре денежные проверки Confirmation, включая `racing trusted events fulfill an intent once and never retarget it`), `tests/billing.unit.test.ts`, `tests/billing.integration.test.ts`, `tests/browser/billing.test.ts`, `tests/fixtures/fake-yookassa-server.ts`. Адаптировать существующие строгие payload и verified fixture, доказать новым oracle V1→V2 ноль POST, опоздавший webhook, 24-часовое окно и конкурирующие права. `createPaymentIntent` остаётся внутренним путём для legacy fixtures, из HTTP всегда используется новый gate. A2/A3/A4/A7.

### TASK-6: Обеспечить устойчивую доставку письма и полную локальную очистку — ADR-002, ADR-003, FR-10, NFR-1, NFR-2, NFR-3, NFR-5, C-2, C-3

SPARC refinement. Автор 2, 2–3 ч. Зависит от TASK-1/2/3/5. `packages/db/src/{purchase-mail-delivery.ts,erasure.ts}` и общая 017 принадлежит тому же автору. `apps/worker/src/{index.ts,purchase-mail-watchdog.ts}`, страницы `dashboard/account/AccountScreen.tsx`, `account/erased/ErasureStatus.tsx`. Постановка записи атомарна с grant, 5 due за 60 с последовательно, lease 30 с, максимум 5 с паузами 1/5/30/120 мин и окно 23 ч 50 мин от first_send_at, disabled TTL 7 дней до первой попытки. `account → delivery` разграничивает erasure и допуск к сети. Поздний CAS не возвращает очищенный payload. Обезличенные диагностика и квитанция показывают границы внешнего хранения.

Test: `tests/customer-trust-billing.integration.test.ts` — `purchase email has one durable delivery and a stable Resend key`; обновить `tests/account-erasure.integration.test.ts`, `tests/account-erasure-review2.integration.test.ts`, `tests/browser/account-erasure.test.ts` по pending/leased/dispatch/accepted race и неизменному финансовому минимуму. A8, fail selected old payload resurrection, two workers and no post after cutoff.

### TASK-7: Подключить поддержку с изолированной историей — ADR-003, FR-9, NFR-1, NFR-4, NFR-5, C-2, C-3

SPARC refinement. Автор 2, 2–3 ч. Зависит от TASK-1, контрактов auth из TASK-3 и runtime TASK-9. `apps/web/src/server/{customer-support-settings.ts,customer-support-session.ts}`, новые `/api/support/session`, `/api/support/authority`, `apps/web/src/app/support/{page.tsx,CustomerSupportPanel.tsx,trust-support-panel.module.css}`, `apps/web/src/lib/customer-support-widget.ts`. Отдельный inbox, 60-с JWT под текущей verified сессией, вызов после уведомления, доверенный signal origin/iframe, 8 с readiness. `BroadcastChannel` и `storage` сигнал из auth UI, preflight authority при `focus/pageshow/bfcache`, каждые 15+2 с при видимости. Обычное закрытие сохраняет свой диалог, отказ и чужой контекст скрывают SDK. Не загружать внешний SDK до действия.

Test: `tests/customer-trust-support.unit.test.ts` и `tests/browser/customer-trust-support.test.ts` по всем типам отказа, отдельным iframe, позднему callback и двухвкладочному reset/logout. Перед checkout fake подтверждает запросы только в тестовую сеть. A2/A5.

### TASK-8: Собрать общие страницы, публичный виджет и тестовую изоляцию — ADR-003, FR-1, FR-9, NFR-2, NFR-4, NFR-5, C-1, C-2, C-3, C-4

SPARC architecture/refinement. Корневой интегратор, 2–3 ч. Зависит от TASK-1, TASK-4/7 для контента и внешней страницы. Один писатель публичных `layout.tsx`, `SiteHeader.tsx`, `TrustSiteFooter.tsx`, pricing page, `dashboard/LogoutButton.tsx`, widget `api.ts`, `chat-window.ts`, `styles.ts`, серверных `widget-deps.ts`, `widget-handler.ts` и `widget-runtime.ts`. Публичные реквизиты и уведомление берутся из утверждённого реестра, виджет проверяет URL, не меняет канонические quote/index/badge правила и проходит 45 KiB gzip. `apps/web/next.config.ts` задаёт exact headers для `/verify-email`, `/reset` и ограниченную наружную границу `/support`; другие origins/CORS не расширяются. `scripts/check-customer-trust-load.mjs` управляет сопоставимой нагрузкой, измерениями и порогами 05, в тестовой сети нет выхода в prod. Владелец внешнего интерфейса UI получает общий claim contract.

Test: `tests/customer-trust-runtime.integration.test.ts`, `tests/widget-handler.unit.test.ts`, `tests/widget-config.integration.test.ts`, `tests/browser/widget-embed.test.ts`, `tests/compose.test.ts` и обязательный `tests/browser/customer-trust-legal.test.ts`. В раздельных fake/offline прогонах поддержка/почта/оплата сообщают фактическое состояние, production network отсутствует.

### TASK-9: Подключить общие манифесты, сборку, runtime и db exports — ADR-001, ADR-002, ADR-003, NFR-2, NFR-5, C-2, C-3

SPARC architecture. Корневой интегратор, 60–90 мин на скелет и 60–90 мин на финальную связку. После TASK-1 можно подготовить workspace manifests, lock, Docker и тестовые алиасы. После TASK-2/3/5/6/7 привязать общие entrypoints и импорты. Root единственный владелец `package.json`, `package-lock.json`, `apps/web/package.json`, `apps/worker/package.json`, `packages/notifications/package.json`, `Dockerfile`, `docker-compose.yml`, `compose.test.yml`, `.env.example`, `.env.vps.example`, `packages/db/src/index.ts`, `apps/web/src/{preflight.ts,server/environment.ts,server/runtime.ts}`, `apps/worker/src/environment.ts`, `vitest.config.ts` и `vitest.browser.config.ts`. Только явные allowlisted env поля, ключи читают web/worker по потребителю. Существующие стартовые контуры сохраняют форму, off/disabled допускают работу без ключей.

Test: `tests/compose.test.ts` и `tests/customer-trust-runtime.integration.test.ts`, новые проверки передачи только нужных переменных и поддержки пустых режимов. `npm ci` на корне и `scripts/check-env-wiring.sh` только с синтетическим env, `npm run build` и `npm run typecheck` с Node 22 и без публикации секретов. A8.

### TASK-10: Доказать цели на объединённой реализации и закрыть локальную поставку — ADR-001, ADR-002, ADR-003, FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-10, NFR-1, NFR-2, NFR-3, NFR-4, NFR-5, C-1, C-2, C-3, C-4

SPARC completion. Root + новые независимые QE, около 2–4 ч включая измерения. Зависит от TASK-2–9. Прогнать перечисленные тесты, полный локальный suite, отдельный Chromium, три парных опыта по 05, проверить active/erasing и исторические строки до/после 016/017. Покрыть все A1/A2/A3/A4/A5/A6/A7/A8 и условные отказы. Закрыть независимые findings, native stage 7/8/9 и испытания различительности; только после свидетельств отметить OpenSpec. Отложенные операции с реальными API не исполняются.

## Dependency order and parallel groups

| Группа | Писатель | Зависимость и граница |
| --- | --- | --- |
| 1. Identity, legal, notifications | Новый автор `gpt-6.2-astra/high` | TASK-2/3/4. Единственный writer миграции 016, signup/auth/UI, документов и `payment-return.ts`. Не владеет манифестами. |
| 2. Billing, support, worker | Новый автор `gpt-6.2-astra/high` | TASK-5/6/7. Единственный writer 017, `payments.ts` и `erasure.ts`, экраны upgrade/return, account erasure, support/worker. Может писать TDD и локальные seams параллельно группе 1, объединённый SQL/API прогон после её миграции и контракта. |
| 3. Интеграция | Root | TASK-8/9/10. Единственный writer package manifests/lock, схемы сборки/Compose, env examples/runtime, DB barrel, shared public shell, публичного виджета и тестового контура. С UI-потоком закрепить это же владение `layout.tsx`, `SiteHeader.tsx` и pricing page, чтобы реальная интеграция была одноразовой. |

TASK-1 → скелет TASK-9 → параллельно TASK-2/3 и заготовки TASK-5/7. TASK-4 следует за TASK-3. Полные TASK-5/6 используют 016, TASK-7 получает поддерживаемый auth сигнал. TASK-8 и финал TASK-9 собирают результаты авторов, TASK-10 проверяет объединённое дерево. Если build внутри 016/017 или на barrel невозможен до соединения, автор запускает целевые чистые unit с согласованным интерфейсом и передаёт проверку настоящего entrypoint интегратору. Прерывание шага не отменяет обязательный downstream прогон.

## Checkpoints

| Точка | Условие и свидетельство |
| --- | --- |
| До кода, TASK-1 | Native convergence закрыт, K1 проверяет список ниже, K2 читает literal targets и строгую трассировку. `openspec status --change customer-trust --json` даёт `isPlanningComplete=true`, `validate --strict` exit 0. Root запускает окончательный Stage 6. |
| Переход схемы, TASK-3/5 | Пустая локальная БД и снимок baseline проходят 016/017. До/после сравнить аккаунты и исторические charges. Версии принимаются в транзакции, proof и снимок не backfill без доказательства. Миграции append-only, prod rollback отдельно от локального reversible-теста. |
| Отказные сценарии, TASK-2–8 | Сохранять red для соответствующих мутаций, затем green функциональных, интеграционных и настоящих браузерных сценариев. Отдельные имитаторы фиксируют отсутствие запросов при запрете, гонки/сдвиг часов и исключение трафика вне внутренней сети. |
| Объединённое дерево, TASK-9/10 | Node 22 `npm ci`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm test`, Compose с pgvector/Redis, `scripts/check-responsive.sh --test …` с сетевой границей, `scripts/check-env-wiring.sh`. Парная нагрузка по 05. Связь всех утверждений с исходом и логом без секретов. |
| Независимое QE, TASK-10 | Native Stage 7 делает exact code target и manifest check. Stage 8 сверяет convergence, названия `dz amendment-check`, фактическую различительную способность `dz discrimination-check` или детерминированные Red/Green receipts, `dz claim-check --fail-on high` и repo guard. Stage 9 закрывает fleet/QE. Если нативная проверка не распознаёт локальный runner, записать наблюдаемый предел и доказательство отдельных мутаций. |
| Реальные внешние результаты | Вне текущей поставки: отдельный inbox, DNS/Resend, фискальный профиль и LIVE. Выключенные состояния и реализация полны локально. Нет утверждения о доставке/фискальном чеке или проверенной внешней истории без активации. |

## Risk assessment and requirement coverage

| Acid | Владелец задачи | Дискриминирующий тест |
| --- | --- | --- |
| A1 | TASK-3 | `tests/customer-trust-auth.integration.test.ts` — `email verification is current-address bound and consumed exactly once` и `forgot responses are indistinguishable and reset revokes every session atomically`. Конкурентный POST и отзыв старой сессии. |
| A2 | TASK-5, TASK-7 | `tests/customer-trust-billing.integration.test.ts` — `new checkout requires a verified current account and immutable fiscal receipt`; `tests/customer-trust-support.unit.test.ts` — `support JWT requires a verified current account and its dedicated inbox configuration`. Отсутствуют вызов оплаты и JWT при отказе. |
| A3 | TASK-5 | `tests/customer-trust-billing.integration.test.ts` — `new checkout requires a verified current account and immutable fiscal receipt`. Подменённые сумма, email и налоговые поля не входят в fake POST. |
| A4 | TASK-5 | `tests/customer-trust-billing.integration.test.ts` — `bound and unbound retries respect the provider window and keep legacy intents intact`. После 24 ч число POST не растёт. |
| A5 | TASK-7 | `tests/browser/customer-trust-support.test.ts` — `Libredesk readiness and identity transitions never reveal the previous conversation`. Ложный ready, поздний SDK, logout другого окна и hide-only проверяются отдельно. |
| A6 | TASK-3, TASK-4 | `tests/customer-trust-auth.integration.test.ts` — `forgot responses are indistinguishable and reset revokes every session atomically`; `tests/browser/customer-trust-auth.test.ts` — `recovery fragments are POST only and safe PDF continuation stays available`. GET не меняет SQL. |
| A7 | TASK-5 | `tests/customer-trust-billing.integration.test.ts` — `lower payments cannot extend an active higher plan across checkout and fulfillment` и `bound and unbound retries respect the provider window and keep legacy intents intact`. Для легаси bound оплату можно применить, младший конфликт идёт на сверку. |
| A8 | TASK-2, TASK-3, TASK-6 | `tests/customer-trust-auth.unit.test.ts` — `mail transport bounds time and response bytes without exposing secrets`; `tests/customer-trust-billing.integration.test.ts` — `purchase email has one durable delivery and a stable Resend key`. Fake accepted подтверждает приём, фактическая доставка и фискализация не выводятся из него. |

Пробелы плана отслеживаются по заголовкам TASK, каждому подтверждению ADR, восьми acid cases и 12 условиям QCSD. Основные риски — несовместимое владение shared файлами, неверное доказательство принятой версии, ранний webhook, долгий неизвестный POST, потерянный lease, reset во второй вкладке, изменения vendor history. Они разложены по тестовым оракулам и Amendments. Если нужно новое имя или путь, обновить план по факту, повторить K1/K2 и указать owner передачи. В рабочей итерации C1/C8 не заменяются упоминаниями в этом разделе.

## K1 inventory

- Новые basenames TypeScript: `customer-mail-settings`, `customer-resend-transport`, `customer-mail-templates`, `customer-email-proof`, `customer-email-actions`, `preview-claim-context`, `customer-auth-signal`, `trust-legal-catalog`, `TrustLegalDocument`, `CustomerRecoveryForm`, `purchase-mail-delivery`, `purchase-mail-watchdog`, `customer-support-settings`, `customer-support-session`, `customer-support-widget`, `CustomerSupportPanel`, `TrustSiteFooter`.
- Новые именованные экспорты: `CustomerMailSettings`, `CustomerMailMessage`, `CustomerMailResult`, `CustomerMailTransport`, `readCustomerMailSettings`, `createCustomerMailTransport`, `renderAccountAccessMessage`, `renderPurchaseConfirmation`, `CustomerEmailProofStore`, `createCustomerEmailActionHandler`, `previewClaimContext`, `publishCustomerAuthChange`, `readTrustDocument`, `listTrustDocumentLinks`, `TrustDocumentKind`, `TrustLegalDocument`, `CustomerRecoveryForm`, `openVerifiedPaymentIntent`, `PurchaseMailDeliveryStore`, `runPurchaseMailTick`, `loadCustomerSupportSettings`, `CustomerSupportSettings`, `createCustomerSupportSessionHandler`, `createCustomerSupportAuthorityHandler`, `openCustomerSupportWidget`, `CustomerSupportPanel`, `TrustSiteFooter`.
- Новых npm script names нет. `build`/`typecheck` нового workspace повторяют действующий интерфейс, проверяются по точному manifest path. `page.tsx`, `route.ts`, `index.ts`, а также Next `GET`, `POST`, `runtime`, `metadata`, `dynamic` принадлежат framework/пакетной области, для новых entrypoint проверяется точный полный путь из нижнего блока, существующие сопоставлены с владельцами. K1 не выдаёт этим общесистемным именам ложную глобальную уникальность. Иное вводимое доменное имя требует повторной проверки до записи.

## Expected target ownership

Финальный список содержит точные repo-relative файлы. T3/T4 владеет auth, legal и mail кодом, T5/T6/T7 — billing/erasure/support/worker, T8/T9 — glue и общий тестовый контур. Существующие routes, чьи формы меняются, указаны полными Next-путями. Регрессии, которые планируется запускать без правок, остаются вне ожидаемых изменений.

## Передача исполнения нагрузочного контура

После завершения identity автора интегратор передаёт одному отдельному `gpt-6.2-sol/high` автору только `scripts/check-customer-trust-load.mjs`, `tests/customer-trust-runtime.integration.test.ts`, `tests/fixtures/customer-trust-load.mjs` и `tests/fixtures/customer-trust-load-transport.mjs`. Первые два пути уже предусмотрены TASK-8. Два дополнительных fixture разделяют проверяющий HTTP runner, подготовку реальных данных/очереди и synthetic network transport, сохраняя лимит 500 строк. Автор владеет нагрузочной частью приватного стенда, не изменяет продуктовые исходники или baseline. Root сохраняет общую интеграцию и браузерный контур. Методика, исходный commit, длительности, квоты и пороги 05 не меняются.
