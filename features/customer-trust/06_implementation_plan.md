# План реализации customer-trust

Inputs read: `00_complexity_assessment.md`, `01_requirements.md`, `02_research.md`, `03_adr/`, `03_shift_left.md`, `03.5_ideation_report.md`, `04_domain_model.md`, `05_architecture.md`, `owner-authority.md` и OpenSpec `customer-trust`.

**Обязательное чтение для каждого автора перед кодом:** [06_ownership.md](06_ownership.md) содержит подробные TASK, владельцев, зависимости, тестовые оракулы и K1. [06_interfaces.md](06_interfaces.md) содержит общий пакетный контракт, payload, сигналы UI и границы миграций. Также читать проверенные `01_requirements.md`, полный `03_adr/`, `04_domain_model.md`, `05_architecture.md` и [OpenSpec customer-trust](../../openspec/changes/customer-trust/). Литеральный список файлов и проверяемые поправки ниже сохраняют силу.

## Goal state

Run ID `sufler-trust-20261125-1`, XL. QCSD `3bdcaeed42340b3ee1f8050f3a132f453ae8ad24787d4ac5c489498753b70283`. SPARC-GOAP: спецификация FR/ADR → переходы proof/checkout/lease/erasure → архитектурные контракты → TDD и реализация → локальная интеграция, измерения и независимый QE. Исходный checkout сохраняет auth, сессии, preview/partner, оплату, erasure, RAG и worker. Цель — покрыть все MUST, A1–A8 и Confirmation. Реальные API, ключи и активация отложены владельцем.

## Tasks

### TASK-1: Закрепить интерфейсы и границы — ADR-001, ADR-002, ADR-003, NFR-2, NFR-5, C-2, C-3, C-4

Root, specification/architecture. Закрытый QCSD → договоры, K1, native K2, OpenSpec status/strict и Stage 6; затем допуск к коду.

### TASK-2: Сделать общий транспорт писем — ADR-001, ADR-002, FR-3, FR-4, FR-10, NFR-1, NFR-2, NFR-5, C-3

Автор 1, refinement после TASK-1 и скелета TASK-9. `@n6/notifications`: Resend HTTPS, 5 с, 16 КиБ, два запроса на web-процесс, без redirect и секретов в диагностике. `tests/customer-trust-auth.unit.test.ts` — `mail transport bounds time and response bytes without exposing secrets`. A8.

### TASK-3: Добавить доказательство email и версии согласий — ADR-001, ADR-003, FR-2, FR-3, FR-4, FR-5, NFR-1, NFR-2, NFR-3, C-4

Автор 1, pseudocode/refinement после TASK-1/2. 016, строгий signup, обе версии с серверными digest в транзакции аккаунта, claim context, verify/forgot/reset. Активация digest только после принятия почты, reset атомарно отзывает доступ. `tests/customer-trust-auth.integration.test.ts`, `tests/customer-trust-legal.integration.test.ts` — `registration records two current legal versions only for the actual new account`. A1/A6/A8.

### TASK-4: Доставить публичные документы и auth UI — ADR-001, ADR-003, FR-1, FR-2, FR-3, FR-4, FR-5, NFR-1, NFR-4, C-1, C-4

Автор 1, refinement после TASK-3. Версии условий/оферты/privacy/consent/cookies, отдельные подтверждения signup, повторное открытие письма во втором браузере, точный PDF next и одноразовый claim hint. Автор 1 также владеет `payment-return.ts` по согласованному статусу TASK-5. `tests/browser/customer-trust-auth.test.ts`, `tests/browser/customer-trust-legal.test.ts` — `public documents and visitor notice expose the approved Sufler terms and contacts`. A6/A8.

### TASK-5: Применить оплату по верному намерению — ADR-002, FR-6, FR-7, FR-8, NFR-1, NFR-3, NFR-4, NFR-5, C-1, C-3

Автор 2, pseudocode/refinement после интерфейса 016. 017, current verified session, `offer_version`, серверная цена и `full_payment`, неизменный снимок до POST, привязка provider ID, предел окна, guard прав и сверка именно этого intent. `tests/customer-trust-billing.integration.test.ts` — `racing trusted events fulfill an intent once and never retarget it`. Регрессии `tests/billing.unit.test.ts`, `tests/billing.integration.test.ts`, `tests/browser/billing.test.ts`. A2/A3/A4/A7.

### TASK-6: Доставить письмо и очистить записи при erasure — ADR-002, ADR-003, FR-10, NFR-1, NFR-2, NFR-3, NFR-5, C-2, C-3

Автор 2, refinement после TASK-2/3/5. Существующий watchdog, `lease → account/delivery admit → HTTP → CAS`, retry 1/5/30/120 мин, 5 попыток и 23 ч 50 мин от первого допуска. Erasure закрывает новый допуск, очищает копии и сохраняет локальный финансовый минимум. `tests/customer-trust-billing.integration.test.ts`, `tests/account-erasure.integration.test.ts`, `tests/account-erasure-review2.integration.test.ts`, `tests/browser/account-erasure.test.ts`. A8.

### TASK-7: Подключить отдельный inbox — ADR-003, FR-9, NFR-1, NFR-4, NFR-5, C-2, C-3

Автор 2, refinement после TASK-1/3/9. 60 с JWT, внешний SDK только после действия, readiness 8 с, два origin, hide-only и сброс чужой identity. Poll 15 с с дедлайном 2 с, повторная проверка при focus/pageshow/bfcache и сигналах logout/reset. `tests/customer-trust-support.unit.test.ts`, `tests/browser/customer-trust-support.test.ts`. A2/A5.

### TASK-8: Интегрировать страницы, виджет и проверочную сеть — ADR-003, FR-1, FR-9, NFR-2, NFR-4, NFR-5, C-1, C-2, C-3, C-4

Root, architecture/refinement после TASK-1/4/7. Общий footer, уведомление через конфиг виджета, отдельный Chromium, internal network/deny-egress, парный нагрузочный прогон по 05. `tests/customer-trust-runtime.integration.test.ts`, widget unit/integration/browser и `tests/compose.test.ts`.

### TASK-9: Одним писателем подключить сборку, runtime и DB exports — ADR-001, ADR-002, ADR-003, NFR-2, NFR-5, C-2, C-3

Root, architecture: workspace shell после TASK-1, итоговая связка после TASK-2/3/5/6/7. Манифесты, lock, Docker/Compose, env examples, aliases, DB barrel и runtime. Проверить Node 22 `npm ci`, build/typecheck, isolated compose, `scripts/check-env-wiring.sh`, `tests/compose.test.ts`. A8.

### TASK-10: Доказать результаты объединённой реализации — ADR-001, ADR-002, ADR-003, FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-10, NFR-1, NFR-2, NFR-3, NFR-4, NFR-5, C-1, C-2, C-3, C-4

Root + независимый QE, completion после TASK-2–9. Сравнить свежую и мигрированную БД. Прогнать полный локальный suite, Chromium, парную нагрузку, native Stage 7/8/9, `dz amendment-check`, `dz discrimination-check` или детерминированные red/green receipts, claim-check и repo guard. OpenSpec tasks отмечаются по фактам. A1/A2/A3/A4/A5/A6/A7/A8.

## Dependency order and parallel groups

TASK-1 → скелет TASK-9 → автор 1 (TASK-2/3/4) и автор 2 (TASK-5/6/7) с общими контрактами. Root интегрирует TASK-8/9, потом TASK-10. 016 пишет только автор 1, 017 и `erasure.ts` — автор 2. Shared build/runtime/DB barrel и footer/widget — root. Next paths проверяются по полным путям; список доменных имён K1 и точное распределение файлов — [06_ownership.md](06_ownership.md).

Канонические стыки — [06_interfaces.md](06_interfaces.md). `@n6/notifications`: `readCustomerMailSettings`, `createCustomerMailTransport`, `renderAccountAccessMessage`, `renderPurchaseConfirmation`, `send(message,{idempotencyKey?})`. Стабильное письмо покупки без auth proof. Signup `terms/consent:{accepted,version}`, checkout `offer_version`; сервер пишет digest. PDF только `/dashboard?source=pdf`, `X-Sufler-Claim-Context` и 2-минутный `n6_preview_claim_notice_v1`. Viewer authority из текущей сессии, смена через `BroadcastChannel('n6-auth')` / `n6_auth_epoch`. Checkout status `reconciliation_required` разрешает повтор GET без нового POST.

## Checkpoints and risk coverage

До кода — K1, K2 strictly, OpenSpec complete и Stage 6. После DDL — пустая и прежняя локальная БД, точные негативные токены и суммы. После сборки — отдельная сеть, suite, container Chromium, измерение 05 и независимый QE. Выключенные провайдеры сохраняют доступные действия. Подробные условия и тестовые оракулы в [06_ownership.md](06_ownership.md).

| Acid | TASK | Точный тест |
| --- | --- | --- |
| A1 | 3 | `email verification is current-address bound and consumed exactly once`; `forgot responses are indistinguishable and reset revokes every session atomically` |
| A2 | 5/7 | `new checkout requires a verified current account and immutable fiscal receipt`; `support JWT requires a verified current account and its dedicated inbox configuration` |
| A3 | 5 | `new checkout requires a verified current account and immutable fiscal receipt` |
| A4 | 5 | `bound and unbound retries respect the provider window and keep legacy intents intact` |
| A5 | 7 | `Libredesk readiness and identity transitions never reveal the previous conversation` |
| A6 | 3/4 | `forgot responses are indistinguishable and reset revokes every session atomically`; `recovery fragments are POST only and safe PDF continuation stays available` |
| A7 | 5 | `lower payments cannot extend an active higher plan across checkout and fulfillment`; `bound and unbound retries respect the provider window and keep legacy intents intact` |
| A8 | 2/3/6 | `mail transport bounds time and response bytes without exposing secrets`; `purchase email has one durable delivery and a stable Resend key` |

## Amendments

- AM-1 (CTQ-01): Второй браузер входит и повторно открывает исходное письмо без переноса секрета. Confirmation: правильная сессия продолжает явно, отозванная ссылка не действует → test `recovery fragments are POST only and safe PDF continuation stays available` in `tests/browser/customer-trust-auth.test.ts` (fails if reverted).
- AM-2 (CTQ-02): Разделить смысл 202 и исправимый пароль от недействительного proof. Confirmation: задержанный Resend не обещает отправку, исправление пароля использует прежний допустимый proof → test `recovery fragments are POST only and safe PDF continuation stays available` in `tests/browser/customer-trust-auth.test.ts` (fails if reverted).
- AM-3 (CTQ-03): Новая покупка сверяет показанную редакцию и ждёт нового действия на V2. Confirmation: переход A→B не делает новый POST или intent → test `new checkout requires a verified current account and immutable fiscal receipt` in `tests/customer-trust-billing.integration.test.ts` (fails if reverted).
- AM-4 (CTQ-04): Сверка рассматривается по своему intent. Confirmation: ранее активный план/выключенный контакт не создают success или повтор checkout → test `reconciliation stays distinct from an active plan and never offers duplicate checkout` in `tests/browser/billing.test.ts` (fails if reverted).
- AM-5 (CTQ-05): Отделить локальное стирание от внешней истории в политике и интерфейсе. Confirmation: квитанция и видимый контакт не обещают внешнее удаление → test `local erasure receipt states the external history boundary` in `tests/browser/account-erasure.test.ts` (fails if reverted).
- AM-6 (CT-RISK-01): Версия оферты является ссылкой на показанную редакцию, snapshot хранит доверенные account/version/digest/time. Confirmation: более новая серверная редакция не засчитывается за показанную, существующий снимок не меняется → test `new checkout requires a verified current account and immutable fiscal receipt` in `tests/customer-trust-billing.integration.test.ts` (fails if reverted).
- AM-7 (CT-RISK-02): Контролировать lease, первый dispatch, ключ, пределы попыток и окно. Confirmation: crash и другой worker не создают новую отправку за окном или новый ключ → test `purchase email has one durable delivery and a stable Resend key` in `tests/customer-trust-billing.integration.test.ts` (fails if reverted).
- AM-8 (CT-RISK-03): До показывания виджета проверять authority и затереть прежнюю identity на смене. Confirmation: bfcache, фокус, другой аккаунт и поздний SDK не дают доступ к старой истории → test `Libredesk readiness and identity transitions never reveal the previous conversation` in `tests/browser/customer-trust-support.test.ts` (fails if reverted).
- AM-9 (CT-RISK-04): В erasure закрыть новые допуски и очистить все локальные копии. Confirmation: начатая сеть и поздний webhook не восстанавливают payload или персональную связь → test `erasure clears customer trust copies across dispatch and late webhook races` in `tests/account-erasure.integration.test.ts` (fails if reverted).
- AM-10 (CT-T01): Выполнить парный нагрузочный опыт с зафиксированным baseline и отклонениями. Confirmation: runner отклоняет превышение пределов 05 и OOM → test `isolated workload rejects p95 and memory regression against baseline` in `tests/customer-trust-runtime.integration.test.ts` (fails if reverted).
- AM-11 (CT-T02): Проверить матрицу и границу допуска на материальных строках. Confirmation: erasure до dispatch даёт ноль HTTP, после dispatch запрещён новый допуск или восстановление строки → test `erasure clears customer trust copies across dispatch and late webhook races` in `tests/account-erasure.integration.test.ts` (fails if reverted).
- AM-12 (CT-T03): Реальные сервисы исключены сетевой границей, fake проверяет протокол. Confirmation: контрольное внешнее обращение блокируется, два origins и счётчики различают источники → test `isolated trust harness denies external egress and counts fake calls` in `tests/customer-trust-runtime.integration.test.ts` (fails if reverted).
- AM-13 (владелец отложил ключи): Выключенные режимы сохраняют действия в кабинете. Confirmation: старые и новые пользователи входят без ключей, fake не выдаёт операционную готовность → test `mail disabled and duplicate registration preserve login and never issue mail` in `tests/customer-trust-auth.integration.test.ts` (fails if reverted).
- AM-14 (стык UI/Trust): Точное PDF-намерение и привязанный к сессии claim hint сохраняют фактическое состояние. Повтор ссылки с fragment в той же открытой странице заново читает доказательство, старый ответ не меняет состояние новой ссылки. Confirmation: query и устаревшая сессия не доказывают claim, PDF без verify доступен → test `recovery fragments are POST only and safe PDF continuation stays available` in `tests/browser/customer-trust-auth.test.ts` (fails if reverted).

- AM-15 (security review payment environment): Before admitting a new durable intent, attest account_id and strict boolean test through authenticated GET /me using the exact immutable constructor credentials. Cache only success on that provider instance and share its in-flight promise; creation reuses it with no second network probe between admission and POST. Failed probes are not cached. New credentials/config require a new instance. Existing unknown POST intents are never cleared from a probe failure. Confirmation: → test `YooKassa attests the actual shop and mode before any payment POST` in `tests/billing.unit.test.ts` (fails if reverted); integration `one immutable shop attestation admits checkout without a second pre-POST failure` in `tests/billing.integration.test.ts`. Contract: https://github.com/yoomoney/yookassa-sdk-python/blob/master/docs/examples/01-configuration.md .
- AM-16 (security pre-review SDK integrity): The audited SDK is trusted application code. A credential-free fixed-URL proxy verifies SHA384 before serving; browser SRI verifies again. CSP permits no remote SDK script. Confirmation: → test `support SDK proxy serves only the audited bytes without forwarding account credentials` in `tests/customer-trust-support.unit.test.ts` and mutated-byte browser rejection in `tests/browser/customer-trust-support.test.ts` (fails if reverted). This is integrity pinning; actual inbox-history filtering still requires separate activation evidence.
- AM-17 (security pre-review refund binding): Trusted refund metadata cannot retarget an unrelated intent. Enforce bound payment, provider/shop and amount before linking an intent; otherwise write only unassociated financial review. Confirmation: → test `foreign refunds cannot rebind or block a different checkout intent` in `tests/customer-trust-billing.integration.test.ts` (fails if reverted).
- AM-18 (security pre-review dispatch deadline): Admission returns its DB-bounded lease and first-send deadline; recheck before transport entry and bound the physical HTTP request to the remaining interval. Confirmation: → test `a paused admitted mail attempt cannot dispatch after its deadline` in `tests/customer-trust-billing.integration.test.ts` (fails if reverted).
- AM-19 (CT-PRIMARY-01 cold retry deadline): Preserve the original checkout deadline across cold credential attestation and check it immediately before the physical payment POST. Expired dispatch returns reconciliation for the same intent; its snapshot and provider key stay unchanged. Confirmation: → test `a cold retry crossing its dispatch deadline preserves the old intent without POST` in `tests/billing.integration.test.ts` (fails if reverted).
- AM-20 (CT-PRIMARY-02 instrument correction): Preserve the signed scheduling jitter and accept only [-2, 1000) milliseconds: two independent integer-millisecond timer floors may fire just before the nominal tick. No response duration, producer, quota, p95 or resource limit changes. Keep the original whole raw report and v1 verdict, then apply the corrected analysis separately with their SHA-256 identities. Confirmation: → test `signed timer jitter permits only two early milliseconds and retains the late deadline` in `tests/customer-trust-runtime.integration.test.ts` (fails if reverted).

- AM-21 (real compiled Next timeout failure): Payment-provider unavailable and verification errors retain their typed identity across independently compiled instrumentation and route modules. Use distinct immutable, own Symbol.for brands on actual Error instances; matching names, reason fields and JSON do not establish identity. Preserve dispatch cutoff and provider-timeout response contracts. Confirmation: → test `payment errors retain identity across independently evaluated modules` in `tests/billing.unit.test.ts` (fails if reverted); independently exercise the compiled Next checkout timeout and cutoff before release.

- AM-22 (failed six-side v2 measurement): Keep the failed raw run and verdict. A fresh symmetric readiness POST with an empty login body must return exactly 422 invalid before the workload clock; never drop tick zero or retry a failed probe. In a new v3 run, only the frozen baseline may retain its observed generic checkout 503 at the exact injected abort; after drain independently read and require its sole original unbound intent. Current checkout timeouts must report the same held intent using the typed code. Confirmation: → test `workload v3 requires readiness and preserves only the frozen baseline timeout contract` in `tests/customer-trust-runtime.integration.test.ts` (fails if reverted).

EXPECTED_CODE_TARGETS:
- .env.example
- .env.vps.example
- Dockerfile
- apps/web/next.config.ts
- apps/web/package.json
- apps/web/src/app/SiteHeader.tsx
- apps/web/src/app/TrustSiteFooter.tsx
- apps/web/src/app/account/erased/ErasureStatus.tsx
- apps/web/src/app/api/auth/email/confirm/route.ts
- apps/web/src/app/api/auth/email/send/route.ts
- apps/web/src/app/api/auth/forgot/route.ts
- apps/web/src/app/api/auth/reset/route.ts
- apps/web/src/app/api/checkout/[intentId]/route.ts
- apps/web/src/app/api/checkout/route.ts
- apps/web/src/app/api/support/authority/route.ts
- apps/web/src/app/api/support/session/route.ts
- apps/web/src/app/dashboard/LogoutButton.tsx
- apps/web/src/app/dashboard/account/AccountScreen.tsx
- apps/web/src/app/forgot/page.tsx
- apps/web/src/app/layout.tsx
- apps/web/src/app/legal/TrustLegalDocument.tsx
- apps/web/src/app/legal/consent/page.tsx
- apps/web/src/app/legal/cookies/page.tsx
- apps/web/src/app/legal/offer/page.tsx
- apps/web/src/app/legal/privacy/page.tsx
- apps/web/src/app/legal/terms/page.tsx
- apps/web/src/app/legal/trust-legal-document.module.css
- apps/web/src/app/login/AuthForm.tsx
- apps/web/src/app/login/page.tsx
- apps/web/src/app/pricing/page.tsx
- apps/web/src/app/reset/page.tsx
- apps/web/src/app/support/CustomerSupportPanel.tsx
- apps/web/src/app/support/page.tsx
- apps/web/src/app/support/trust-support-panel.module.css
- apps/web/src/app/upgrade/UpgradeScreen.tsx
- apps/web/src/app/upgrade/page.tsx
- apps/web/src/app/upgrade/return/ReturnScreen.tsx
- apps/web/src/app/upgrade/return/page.tsx
- apps/web/src/app/verify-email/CustomerRecoveryForm.tsx
- apps/web/src/app/verify-email/page.tsx
- apps/web/src/lib/customer-auth-signal.ts
- apps/web/src/lib/customer-support-widget.ts
- apps/web/src/lib/customer-support-sdk-integrity.ts
- apps/web/src/server/customer-support-sdk-proxy.ts
- apps/web/src/app/api/support/sdk/route.ts
- apps/web/src/lib/payment-return.ts
- apps/web/src/lib/trust-legal-catalog.ts
- apps/web/src/preflight.ts
- apps/web/src/server/auth-handler.ts
- apps/web/src/server/auth-store.ts
- apps/web/src/server/auth.ts
- apps/web/src/server/billing-deps.ts
- apps/web/src/server/billing-handler.ts
- apps/web/src/server/billing-runtime.ts
- apps/web/src/server/customer-email-actions.ts
- apps/web/src/server/customer-support-session.ts
- apps/web/src/server/customer-support-settings.ts
- apps/web/src/server/environment.ts
- apps/web/src/server/payments/config.ts
- apps/web/src/server/payments/provider.ts
- apps/web/src/server/payments/yookassa.ts
- apps/web/src/server/preview-claim-context.ts
- apps/web/src/server/route.ts
- apps/web/src/server/rate-limit.ts
- apps/web/src/server/runtime.ts
- apps/web/src/server/widget-deps.ts
- apps/web/src/server/widget-handler.ts
- apps/web/src/server/widget-runtime.ts
- apps/widget/src/api.ts
- apps/widget/src/chat-window.ts
- apps/widget/src/styles.ts
- apps/worker/package.json
- apps/worker/src/environment.ts
- apps/worker/src/index.ts
- apps/worker/src/purchase-mail-watchdog.ts
- compose.test.yml
- docker-compose.yml
- package-lock.json
- package.json
- packages/db/migrations/016_customer_trust_identity_legal.sql
- packages/db/migrations/017_customer_trust_billing.sql
- packages/db/src/customer-email-proof.ts
- packages/db/src/erasure.ts
- packages/db/src/index.ts
- packages/db/src/partners.ts
- packages/db/src/payments.ts
- packages/db/src/purchase-mail-delivery.ts
- packages/notifications/package.json
- packages/notifications/src/customer-mail-settings.ts
- packages/notifications/src/customer-mail-templates.ts
- packages/notifications/src/customer-resend-transport.ts
- packages/notifications/src/index.ts
- packages/notifications/tsconfig.json
- scripts/check-customer-trust-load.mjs
- tests/account-erasure-review2.integration.test.ts
- tests/account-erasure.integration.test.ts
- tests/auth.test.ts
- tests/billing.integration.test.ts
- tests/billing.unit.test.ts
- tests/browser/account-erasure.test.ts
- tests/browser/billing.test.ts
- tests/browser/customer-trust-auth.test.ts
- tests/browser/customer-trust-legal.test.ts
- tests/browser/customer-trust-support.test.ts
- tests/browser/partners.test.ts
- tests/browser/widget-embed.test.ts
- tests/compose.test.ts
- tests/config.test.ts
- tests/database.integration.test.ts
- tests/enums.test.ts
- docs/canon.md
- tests/customer-trust-auth.integration.test.ts
- tests/customer-trust-auth.unit.test.ts
- tests/customer-trust-billing.integration.test.ts
- tests/customer-trust-legal.integration.test.ts
- tests/customer-trust-runtime.integration.test.ts
- tests/customer-trust-support.unit.test.ts
- tests/fixtures/fake-yookassa-server.ts
- tests/fixtures/customer-trust-load.mjs
- tests/fixtures/customer-trust-load-transport.mjs
- tests/partners.unit.test.ts
- tests/preview-flow.integration.test.ts
- tests/public-page.unit.test.ts
- tests/widget-config.integration.test.ts
- tests/widget-handler.unit.test.ts
- tests/widget-source.test.ts
- vitest.browser.config.ts
- vitest.config.ts
