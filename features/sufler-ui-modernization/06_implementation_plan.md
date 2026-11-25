# План реализации обновления UI Суфлёра

Inputs read: 00_complexity_assessment.md, 01_requirements.md, 02_research.md, 02_reuse_inventory.md, 03_adr, 03_shift_left.md, 03.5_ideation_report.md, 03.5-author-delta.md, 04_domain_model.md, 05_architecture.md, OpenSpec sufler-ui-modernization.

Перед кодом прочитать [точный реестр писателей и интерфейсов](06_ownership.md), [замороженную архитектуру и матрицу fixtures](05_architecture.md#verification-inputs) и [OpenSpec](../../openspec/changes/sufler-ui-modernization/tasks.md). [Квитанция имён и первичных проверок](receipts/plan-author-checks.json).

## Goal state

GOAP. Исходный продукт `32b23aa` имеет рабочие кабинет, предпросмотр, цены и внешний виджет. [QCSD](03.5_ideation_report.md) закрыл проектную проверку двух ADR и восьми условий. Реализация и наблюдение U09 ещё не доказаны.

Цель — 19 требований, оба ADR, восемь поправок и четыре acid cases подтверждены через основной путь Суфлёра от выбора материала до проверки и установки. Условия и ограничения берутся из сервера. Доля общего покрытия неизвестна.

| SPARC | Переход |
|---|---|
| Specification | Связать требования, риски, задачи и тесты в этом плане. |
| Pseudocode | Развести запуск, PDF, retry, состояния опроса и привязку результата claim. |
| Architecture | Переиспользовать Next/React/CSS и действующие серверные контракты с согласованным auth-швом. |
| Refinement | Исполнить регрессии SSR и настоящий маршрут с PostgreSQL, изоляцией и fault fixtures. |
| Completion | Получить U09 на отдельном origin, сборку и независимые Step 8/9. |

## Tasks

### TASK-1: Auth-контракт — ADR-001 · FR-2 · FR-4 · NFR-3 · C-2 · A1

**Architecture.** Customer-trust, после допуска, 45–90 мин. `safeNextPath` допускает ровно `/dashboard?source=pdf` плюс прежние upgrade/invite. Auth с фактическим исходом и проверенной сессией добавляет no-store `X-Sufler-Claim-Context`. Server-only `previewClaimContext` вычисляет base64url HMAC-SHA256 серверным секретом от `sufler-preview-claim-context-v1` + NUL + действительного токена. JSON/HTTP и права прежние. Сырой токен и digest не уходят в URL, логи и cross-origin.

**Test.** `tests/auth.test.ts`, `tests/billing.unit.test.ts` («PDF и тарифы принимают только точные адреса возврата»), `tests/partners.unit.test.ts`. Проверить отсутствие контекста при ложной сессии, строгие отказы внешнему URI, доп. query, fragment, массиву и хвосту, работу разрешённых направлений.

### TASK-2: Публичный старт и безопасный повтор — ADR-001 · ADR-002 · FR-1 · FR-2 · FR-6 · FR-8 · NFR-3 · NFR-4 · C-2

**Pseudocode/Refinement.** UI после допуска, 1,5–2,5 ч. Переиспользовать стартовую форму и явный POST с адресом в теле, переход только по job ID. Одиночный legacy `?url` запускается один раз и исчезает из истории. PDF/retry не запускают чтение, включая смешанный `url`. Userinfo и недопустимый протокол отсекаются до POST/записи.

Корневой HTTP(S)-origin → SHA-256/UUID в `n6_preview_launch_v2`; после 202 job ID → безопасный origin в `n6_preview_retry_v2`. В обоих до 8 записей и 24 ч, с очисткой. Path/query/fragment не сохранять. Полный допустимый адрес и ключ текущей попытки остаются в памяти. Удалять `n6_preview_key:`, переносить UUID лишь точного предъявленного безопасного адреса. Без storage остаётся ручной ввод.

**Test.** `tests/preview-intent.test.ts`, `tests/browser/sufler-source-journey.test.ts`. Ноль авто-POST для демо/PDF/retry, тот же UUID безопасного повтора, пустой ввод при чужой/истёкшей/недоступной записи, отсутствие маркеров в хранилище и новых ссылках.

### TASK-3: PDF для своего бота — ADR-001 · ADR-002 · FR-2 · FR-3 · NFR-3 · NFR-4 · A2

**Refinement.** UI после TASK-2, 45–90 мин. Один старт пустого кабинета, шаги «Материалы → Проверка → Установка», ручные поля сохраняются при ошибке/сворачивании. Недоступный список отличим от пустого. PDF-режим использует настоящий список, выбор явный. Существующий `#source-pdf` открывается у выбранного или явно созданного бота. Лимит и страницы аккаунта/партнёра/студии сохранены.

**Test.** `tests/browser/bot-cabinet.test.ts`, `tests/browser/sufler-source-journey.test.ts` («PDF после входа, автосохранения и предела плана»). Чужой бот даёт 404. Failed preview после auth-claim не создаёт дубль.

### TASK-4: Одноразовый исход claim — ADR-001 · FR-2 · FR-3 · FR-4 · NFR-3 · C-2 · A2

**Refinement.** UI после TASK-1 и TASK-3, 1–1,5 ч. Explicit claim выдаёт тот же заголовок при фактическом результате проверенной сессии. UI сохраняет пару только из ответа в `n6_preview_claim_notice_v1` (<code>{outcome, context, expiresAt}</code>, две минуты). Свежий защищённый SSR использует `currentCabinetSession`, прежний `currentAccountId` поддерживается. Совпавший слот расходуется один раз. Закладка, `saved/preview` в URL, смена сессии, replay и отказ storage не подтверждают успех. Сообщения отделяют сохранение и отказ от готовности, кода, ответов и установки.

**Test.** `tests/preview-flow.integration.test.ts`, `tests/browser/sufler-source-journey.test.ts`. Проверить реально сохранённый failed preview, явный claim, предел и недоступность, свежий/истёкший слот, другую вкладку и сессию A→B.

### TASK-5: Вход и восстановление — ADR-001 · FR-2 · FR-4 · NFR-2 · NFR-3 · A1

**Refinement.** Customer-trust после TASK-1 и TASK-4, 45–90 мин. `AuthForm` сохраняет точное PDF-намерение, включая допустимый email-переход. PDF использует обычную авторизацию, новый checkout — свой email gate. Видимость пароля через Enter/Space и `aria-pressed` сохраняет фокус, ввод и autocomplete. Recovery ведёт к действующему пути. При недоступном storage форма показывает фактический отказ с явным продолжением.

**Test.** `tests/browser/partners.test.ts`, `tests/browser/sufler-source-journey.test.ts` («подтверждение сохраняет проверенное намерение PDF»), смежные auth/recovery тесты. Сохранить вход, переключение регистрации, код партнёра и проверенный возврат.

### TASK-6: Состояние чтения и проверка ответа — ADR-002 · FR-6 · FR-7 · NFR-2 · NFR-4 · C-2 · A4

**Refinement.** UI после TASK-2–4, 1,5–2,5 ч. `running`/`no_response` опрашиваются; `done`/`failed`/404 останавливают опрос. Первый 503/сеть и `done/site:null` показывают отдельный выход, GET только той же задачи. Последний прогресс помечается при позднем отказе. Валидный `done/site` открывает чат; активное состояние возобновляет опрос. Отказ сайта ведёт к PDF или редактированию адреса.

Сразу раскрыть первую серверную цитату в обоих чатах. Один доступный `OwnerAnswerSource`; клавиатурный выбор прошлой цитаты сохраняет фокус, ввод, историю. `unknown` использует реальный контакт, иначе настройки своего бота, явный claim для вошедшего или вход для гостя. Только действительный `first_answer` определяет отдельный CTA `claim/share`. Три локальные отметки не отправляют `ask/claim/verify/publish`.

**Test.** `tests/browser/preview-flow.test.ts`, `tests/browser/bot-cabinet.test.ts`, `tests/browser/gate-onboarding.test.ts`, route tests. Сохранить rel/HTTP(S), квоту, усечение, обе CTA, текстовый/PDF маршрут и серверный gate. «Локальная проверка трёх сценариев без переключения ответов» покрывает A4.

### TASK-7: Композиция, темы и тарифы — ADR-002 · FR-1 · FR-5 · FR-8 · NFR-1 · NFR-2 · C-1 · C-3 · A3

**Refinement.** UI после TASK-2/3/6; оболочка руководителя после TASK-5, 1–2 ч. Помеченный пример в первом десктопном экране, одно действие и подписанное поле. Планы через назначение, runtime цены/лимиты, 30 дней без автопродления, предварительность, правило подписи, прежние CTA. Сохранить Onest, токены, темы и рабочие ссылки.

**Test.** `tests/theme.test.ts`, `tests/browser/design-shell.test.ts` («320×568 и 1440×900, форма и пример на первом экране», «тарифы соответствуют переданным лимитам и работающим CTA»). После шрифта и при scrollY=0 поле/кнопка целиком видны на 320×568, 375×667 и 390×844 в обеих темах. На 1440×900 виден образец. Матрица также проверяет 768×1024, клавиатуру, axe, reduced motion, цели и overflow. Исследование пяти пользовательских сессий отдельно.

### TASK-8: Реальные route fixtures — ADR-001 · ADR-002 · FR-2 · FR-3 · FR-4 · FR-6 · FR-7 · NFR-3 · NFR-4 · NFR-5 · C-4

**Refinement.** UI, подготовка после допуска, итог после TASK-1–7, 2–3 ч. Собранный Next и widget, HTTPS, PostgreSQL/Redis, синтетические A/B и `__Host` cookies. Реальный доступ, claim, сохранение и владение. Управляемые 503, обрыв и `done/null` в browser fixture помечены отдельно. Test-only модель и probe через локальный transport, deny-egress и ноль платных вызовов.

**Test.** `tests/browser/sufler-source-journey.test.ts` и интеграционный preview. Сценарии running 7/20, валидный `done/site` с подсказками, временный отказ, 404, исходы claim, локальные отметки без `verify`, две сессии и таблица утечек. Проверить старые auth, billing, partners и gate тесты.

### TASK-9: Наблюдать U09 — ADR-002 · FR-9 · NFR-5 · C-2 · C-4

**Completion.** UI после TASK-8 и готового bundle, 45–90 мин. Открыть наполненный install route настоящего тестового бота до/после контакта, проверить код, инструкции, clipboard и чужой 404. Вставить дословно выданный тег на отдельном разрешённом origin. Наблюдать браузер, CSP/CORS, реальные config/ask и раздельные first_config/first_answer. Синтетический ответ отмечается, собственный/запрещённый origin и заглушка не подтверждают установку.

**Test.** `tests/browser/sufler-source-journey.test.ts`, `tests/browser/widget-embed.test.ts`, `tests/widget-config.integration.test.ts`, `tests/visitor-ask.integration.test.ts`. Записать revision, origin, viewport/engine, видимый экран, подмены и отдельное решение по U09. Изолированный настоящий стенд обязателен, одной компонентной оснастки недостаточно.

### TASK-10: Сборка и независимое QE — FR-9 · NFR-1 · NFR-2 · NFR-5 · C-1 · C-2 · C-3 · C-4 · C-5

**Completion.** Руководитель после TASK-1–9, 30–60 мин без независимого QE. Фактические manifest Step 7, Step 8 и Step 9. Gate, сборка, lint, typecheck, unit/integration, браузерные сценарии, amendment-check и red/green. Пропуск движка, отсутствующий U09 или сквозное доказательство остаются явным открытым пунктом.

## Dependency order and parallel groups

- TASK-1 и TASK-2 независимы после допуска. TASK-2 → TASK-3 → TASK-4; TASK-4 ждёт TASK-1.
- После TASK-4 идут TASK-5 customer-trust и TASK-6 UI. TASK-7 UI после TASK-6, оболочка после TASK-5.
- Итоговый TASK-8 после обоих потоков, затем TASK-9 → TASK-10. Сборки и стенды последовательно.

Планировщик `gpt-6.2-sol/high`. Одна реализационная UI-единица `gpt-6.2-astra/high` владеет 27 целями. Customer-trust владеет семью, руководитель двумя. [Реестр](06_ownership.md) включает точные цели, K1-имена и границы смежной работы.

## Checkpoints

- До Step 7: проектный K1, native K2, OpenSpec strict/status, Stage 6/convergence, независимый challenge и допуск.
- TASK-1–4: точный return и идемпотентность, настоящий claim и текущая сессия. TASK-5–7: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, SSR и маршруты.
- TASK-8/9: Chromium только в существующем `sufler-ui-audit-browser-1`; закрытый тестовый контур и фактическая квитанция U09. Не устанавливать движки. Ограничения ресурсов и запуск описаны в [реестре](06_ownership.md#детали-проверок-и-среды).
- TASK-10: код по объявленным целям, Step 8/9 и отдельный независимый QE на итоговом снимке. Не выдавать mock, частичную проверку или закрытую ideation за реализацию.

## Risk assessment

| Отказ | Отдельная проверка |
|---|---|
| A1 — внешний/неразрешённый `next` | TASK-1/5 · `tests/billing.unit.test.ts` «PDF и тарифы принимают только точные адреса возврата» плюс invite. |
| A2 — дубликат или ложное сохранение после failed preview | TASK-3/4/8 · route тест «исход claim и фактическая готовность разделены», смена аккаунта и отказ. |
| A3 — кнопка на 320×568 за экраном | TASK-7/8 · `tests/browser/design-shell.test.ts` «320×568 и 1440×900, форма и пример на первом экране». |
| A4 — локальный вид выдаёт серверное подтверждение | TASK-6/8 · `tests/browser/bot-cabinet.test.ts` «локальная проверка трёх сценариев без переключения ответов» и `unknown` route test. |
| Регрессии QCSD | Q-01/02/04 — TASK-6/8; Q-03 и UI-RISK-01 — TASK-3/4/8; UI-RISK-02 — TASK-2/8; UI-T01/02 — TASK-8/9. Проверки ниже. |

## Amendments

AM-1 (Q-01): первый отказ и done/null отличимы. Confirmation: GET того же job без POST → test `завершённое задание без данных сайта и восстановление первого опроса` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-2 (Q-02): первая открытая цитата в обоих чатах. Confirmation: обе раскладки, две цитаты, клавиатура и сохранённый ввод → test `цитата владельца видна до первого нажатия` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-3 (Q-03): claim отделён от готовности. Confirmation: реальный failed autosave подтверждает только сохранение → test `исход claim и фактическая готовность разделены` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-4 (Q-04): достоверный контакт или действие по сессии. Confirmation: без фонового POST и незаработанного first_answer → test `первый unknown с контактом и без него` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-5 (UI-T01): настоящий Next и владелец. Confirmation: cookie, done/site, предел claim и неизменный verify → test `реальный маршрут различает право чтения, исход claim и локальную проверку` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-6 (UI-T02): заполненный экран и отдельный origin. Confirmation: реальный тег, copy/config/first_answer отдельно, source fixture указан → test `заполненная установка и отдельный внешний origin дают наблюдаемую квитанцию` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-7 (UI-RISK-01): одноразовый исход по фактическому ответу и совпавшей сессии. Confirmation: URL-only, replay, истечение, storage и смена аккаунта → test `прямой saved URL, replay и смена аккаунта не доказывают claim` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-8 (UI-RISK-02): приватный URL вне ссылок и хранения, безопасный повтор идемпотентен. Confirmation: userinfo и синтетические маркеры → test `URL с маркерами не появляется в ключах, значениях и новых ссылках` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-9 (UI review terminal retry): A known terminal failed result starts a fresh explicit launch attempt exactly once; transport-unknown POST retries retain that attempt key. Existing quotas may reject it, and that refusal stays visible. GET recovery keeps the same job. Confirmation: → test `terminal failure begins a new attempt while an unknown POST retains its key` in `tests/browser/sufler-preview-recovery.test.ts` (fails if reverted).

AM-10 (UI review claim feedback): Ask and claim errors have separate state. A failed save is announced and visible beside its CTA with continuation, preserving the chat draft. Confirmation: → test `claim failure is announced next to the save action` in `tests/browser/sufler-preview-recovery.test.ts` (fails if reverted).

AM-11 (observed U09 clipboard denial): Keep the installation workflow. A denied or missing clipboard API reports the failure and reveals a labelled readonly field; Tab selects exactly the server-issued tag for manual copying. A later denial must clear earlier success. Confirmation: → test `заполненная установка и отдельный внешний origin дают наблюдаемую квитанцию` in `tests/browser/sufler-source-journey.test.ts` (fails if reverted).

AM-12 (observed footer and pricing scope): Align legal navigation with the page content. Describe pages per site reading and answer periods per Moscow calendar day/month separately from the paid 30 days; prices and enforced limits stay unchanged. Confirmation: → test `тарифы соответствуют переданным лимитам и работающим CTA` in `tests/browser/design-shell.test.ts` (fails if reverted).

AM-13 (FR-4 traceability review): Login advertises password recovery only when email delivery is configured; the support page gives the same honest availability. Direct recovery URLs keep their explicit disabled state. Confirmation: → test `login advertises recovery only when email delivery is configured` in `tests/theme.test.ts` (fails if reverted).

AM-14 (FR-4 keyboard evidence): Native password buttons keep field contents and button focus, expose their pressed state and never submit while switching with Enter or Space in either account mode. Confirmation: → test `login password visibility works with Enter and Space without losing input or submitting` in `tests/browser/customer-trust-auth.test.ts` (fails if reverted).

AM-15 (FR-3 traceability evidence): The ordinary manual creation form preserves entered values when collapsed and reopened and after a real field-validation error; successful creation opens the issued bot at the source section. Confirmation: → test `ручное создание из пустого кабинета сохраняет ввод при сворачивании и ошибке поля` in `tests/browser/sufler-preview-recovery.test.ts` (fails if reverted).

AM-16 (coverage measurement validity): An unimported-file V8 all:true fallback assigns counters to comments, blanks and erased TypeScript. Preserve those invalid projection attempts; obtain actual transformed counters using meaningful default HTTP boundary and server-rendered UI contracts plus focused browser recovery transitions. Never count fallback physical lines as established executable-line percentages. Confirmation: → test `anonymous customer routes reject foreign origins before account or provider access` in `tests/customer-trust-boundaries.unit.test.ts` and test `server-rendered preview and recovery surfaces do not disclose private state` in `tests/customer-trust-ssr.unit.test.ts` (fails if reverted).

AM-17 (measured deadline repair): Preserve the failed six-side report with its one −2.0878 ms early baseline tick. The workload producer exports waitForLoadDeadline, waits by ceil of the remaining absolute monotonic deadline, then rechecks that same clock before dispatch and at the measurement end. Keep the fixed start + tick schedule, every actor/tick, raw unmodified signed lag, existing −2 ms / 1000 ms bounds and all HTTP/resource/quota oracles. Do not regrade the failed report as passed. Confirmation: → test `absolute load deadlines recheck early timer wakeups without shifting or dropping ticks` in `tests/customer-trust-runtime.integration.test.ts` (fails if reverted).

## File ownership

Ниже точные кодовые цели. Путь из блока не даёт право менять файл другого писателя. В [реестре](06_ownership.md) определены границы, новые имена и неизменяемые регрессионные зависимости.


EXPECTED_CODE_TARGETS:
- apps/web/src/app/TrustSiteFooter.tsx
- apps/web/src/app/dashboard/InstallViews.tsx
- apps/web/src/app/dashboard/bots/[botId]/install/InstallScreen.tsx
- apps/web/src/app/Landing.tsx
- apps/web/src/app/OwnerAnswerSource.tsx
- apps/web/src/app/SiteHeader.tsx
- apps/web/src/app/layout.tsx
- apps/web/src/app/globals.css
- apps/web/src/app/preview/page.tsx
- apps/web/src/app/preview/PreviewStart.tsx
- apps/web/src/app/preview/PreviewViews.tsx
- apps/web/src/app/preview/[jobId]/PreviewScreen.tsx
- apps/web/src/app/dashboard/page.tsx
- apps/web/src/app/dashboard/CabinetEmpty.tsx
- apps/web/src/app/dashboard/BotListScreen.tsx
- apps/web/src/app/dashboard/CabinetViews.tsx
- apps/web/src/app/dashboard/PreviewClaimNotice.tsx
- apps/web/src/app/dashboard/bots/[botId]/BotScreen.tsx
- apps/web/src/app/pricing/Pricing.tsx
- apps/web/src/app/login/AuthForm.tsx
- apps/web/src/app/login/page.tsx
- apps/web/src/lib/preview-intent.ts
- apps/web/src/lib/preview-claim-notice.ts
- apps/web/src/lib/payment-return.ts
- apps/web/src/server/preview-handler.ts
- apps/web/src/server/cabinet-session.ts
- apps/web/src/server/auth-handler.ts
- apps/web/src/server/preview-claim-context.ts
- tests/auth.test.ts
- tests/billing.unit.test.ts
- tests/theme.test.ts
- tests/preview-intent.test.ts
- tests/preview-flow.integration.test.ts
- tests/browser/design-shell.test.ts
- tests/browser/preview-flow.test.ts
- tests/browser/bot-cabinet.test.ts
- tests/browser/gate-onboarding.test.ts
- tests/browser/sufler-source-journey.test.ts
- tests/browser/customer-trust-auth.test.ts
- tests/browser/sufler-preview-recovery.test.ts
- tests/fixtures/sufler-source-journey.ts
- tests/fixtures/sufler-ui-test-transport.mjs
- tests/customer-trust-boundaries.unit.test.ts
- tests/customer-trust-ssr.unit.test.ts
- tests/browser/sufler-ux-recovery-branches.test.ts
- tests/customer-trust-css.d.ts
