# Tasks

Источник файлов, владельцев и негативных сценариев — [Step 6](../../../features/customer-trust/06_implementation_plan.md). Два автора используют один общий workspace интерфейс, менеджер манифестов и реестр из TASK-1/9.

## 1. Граница реализации

- [ ] 1.1 TASK-1. Подтвердить неизменённую независимую ревизию, exact K1 и полный K2, проверить OpenSpec planning complete и Stage 6.
- [ ] 1.2 TASK-9. Создать общий workspace манифест и сборочную связку с одним писателем lockfile, проверить Node 22 build и manifest copy.

## 2. Identity, legal и notifications

- [ ] 2.1 TASK-2. Подключить общий Resend транспорт и шаблоны. Проверить размер, timeout, отказ при redirect и отсутствие чувствительных логов в `tests/customer-trust-auth.unit.test.ts`.
- [ ] 2.2 TASK-3. Ввести 016, регистрацию с отдельными подтверждениями и proof для verify/reset. Проверить известный и неизвестный forgot, reset/verify гонки и атомарное принятие в `tests/customer-trust-auth.integration.test.ts` и `tests/customer-trust-legal.integration.test.ts`.
- [ ] 2.3 TASK-4. Опубликовать документы, сохранить PDF next и восстановление с исходным письмом, показать состояния без фиктивного подтверждения. Проверить `tests/browser/customer-trust-auth.test.ts`, `tests/browser/customer-trust-legal.test.ts` и интерактивную регистрацию партнёров.

## 3. Billing, worker и support

- [ ] 3.1 TASK-5. Ввести 017 и использовать подтверждённый текущий email, показанную редакцию, неизменяемый снимок и доверенный provider ID. Проверить V1→V2, ранний webhook, границу 24 часов и младший план в `tests/customer-trust-billing.integration.test.ts`, `tests/billing.unit.test.ts` и `tests/billing.integration.test.ts`.
- [ ] 3.2 TASK-5. Выделить сверку конкретного intent в upgrade/return. Проверить разные отображения статуса, повтор только GET и отключённый канал в `tests/browser/billing.test.ts`.
- [ ] 3.3 TASK-6. Подключить устойчивую доставку через watchdog и матрицу удаления. Проверить две конкурирующие выдачи lease, постоянный ключ, cut-off и поздний webhook в `tests/customer-trust-billing.integration.test.ts` и `tests/account-erasure.integration.test.ts`; сверить границу локальной квитанции в `tests/browser/account-erasure.test.ts`.
- [ ] 3.4 TASK-7. Подключить отдельный inbox и `/support` с серверной authority, явным действием, iframe readiness и сменой вкладки. Проверить JWT и отказные сценарии в `tests/customer-trust-support.unit.test.ts`, `tests/browser/customer-trust-support.test.ts`.

## 4. Интеграция и свидетельства

- [ ] 4.1 TASK-8/9. Связать реестр с общими страницами и публичным виджетом, подключить env-примеры, runtime, DB barrel, сборку и изоляцию. Проверить `tests/widget-config.integration.test.ts`, `tests/browser/widget-embed.test.ts`, `tests/customer-trust-runtime.integration.test.ts` и `scripts/check-env-wiring.sh`.
- [ ] 4.2 TASK-10. Запустить объединённые typecheck/build/lint и все локальные тесты, выделенный Chromium и парный нагрузочный профиль. Передать результаты независимому QE, сверить native Stage 7/8/9, Confirmation и проверку различимости отказов.

## Workflow follow-up

- Включение реальных провайдеров — отдельная операция после добавления ключей и проверки магазина, почты и фильтрации отдельного inbox. Локальные проверки не вызывают эти сервисы.
- Архивировать change только после подтверждённых локальных задач, исходов и независимого review.
