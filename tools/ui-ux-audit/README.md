# Выделенный контейнер UI/UX-аудита

Результат 25.11.2026: [Суфлёр × Chatbase](../../docs/ui-ux/chatbase-comparison-2026-11-25/README.md).

Контейнер создан для анализа интерфейса Суфлёра и сравнительного ориентира Chatbase. Proofwall в запуск не входил. Playwright **1.64.1**, Chromium headless shell **156.0.8078.4**, axe Playwright **4.11.0**. Пакеты закреплены lock-файлом; браузер ставится той же версией Playwright. Проверки выполняются внутри контейнера, браузер хоста не используется.

## Изоляция

Отдельный Compose-проект `sufler-ui-audit`, без публикации портов и без Docker socket. Скрипты монтируются read-only; запись — только в `artifacts/` и временные каталоги. Пользователь 10001, read-only rootfs, cap_drop=ALL, no-new-privileges, до 1100 MiB RAM и 1 CPU. Chromium sandbox отключён для контролируемого тестового сценария; это не контейнер для произвольного web-crawling.

Запуск от root на текущем VPS:

```bash
cd /home/rag-sales-chatbase/tools/ui-ux-audit
mkdir -p artifacts
chown 10001:10001 artifacts
chmod 750 artifacts
docker build -t sufler-ui-audit:pw1.64.1 .
docker compose -f compose.yml up -d --no-build --pull never
docker compose -f compose.yml exec -T browser node /audit/scripts/discover.mjs
docker compose -f compose.yml exec -T browser node /audit/scripts/audit-public.mjs
docker compose -f compose.yml exec -T browser node /audit/scripts/reference-assets.mjs
```

На исходном VPS рабочие материалы сохранены отдельно в `/home/research/sufler-ui-ux/`, контейнер использует именно этот каталог. Одновременно запускать второй Compose-проект с тем же именем не нужно. Кэш временного Buildx builder после сборки удалён.

## Авторизованные экраны

Использовать только отдельный тестовый аккаунт. `login-sufler.mjs` создаёт сессию через форму входа и сохраняет её исключительно в `artifacts/.private/`; пароль не печатается, трассировка авторизации не ведётся. Для текущего отчёта аккаунт был пустым. Сценарий прекращает публикационную съёмку, если вместо пустого кабинета обнаружены данные.

На VPS владелец заполняет приватный файл `/home/rag-sales-chatbase/.secrets/ui-ux-audit-access.json` с правами 0600. Пример структуры — `access.example.json`, значений в нём нет. Передавать пароли через чат, аргументы команды или Docker environment не нужно.

```bash
mkdir -p artifacts/.private
chown 10001:10001 artifacts/.private
chmod 700 artifacts/.private
install -m 600 -o 10001 -g 10001 ../../.secrets/ui-ux-audit-access.json artifacts/.private/access.json
docker compose -f compose.yml exec -T browser node /audit/scripts/login-sufler.mjs
docker compose -f compose.yml exec -T browser node /audit/scripts/scenarios.mjs
docker compose -f compose.yml exec -T browser node /audit/scripts/extra-reference.mjs
```

Во время аудита разрешён только POST входа; другие изменения блокируются. Статусы, ошибки и ответы для предпросмотра подменяются **в браузере**, реальная индексация и запросы моделей не выполняются. Новые боты, источники, оплаты и публикации не создаются. `scenarios.mjs` требует подготовленную сессию пустого аккаунта для части проверок; отсутствие доступа нельзя заменять фиктивным успехом.

## Концепты и альбом

```bash
mkdir -p artifacts/proposals
cp ../../docs/ui-ux/chatbase-comparison-2026-11-25/prototype.html artifacts/proposals/prototype.html
docker compose -f compose.yml exec -T browser node /audit/scripts/render-proposals.mjs
```

`build-report.py` и `write-gallery.py` — генераторы конкретного отчёта 25.11, а не универсальная система выводов. Для другого запуска нужно заново проверить наблюдения и дату, не перезаписывать опубликованные выводы новыми скриншотами автоматически. `render-report.mjs` проверяет локальные фильтры, изображения, модальное окно и экспортный альбом, затем создаёт PDF. Его HTTP-сервер слушает только loopback внутри контейнера; порт хоста не открывается.

Каталог этого инструмента исключён из корневого Docker-контекста приложения. Его собственный Docker-контекст включает только Dockerfile и package-файлы.

Сырые артефакты, cookie-состояние и доступы не коммитятся. Перед публикацией отбираются только изображения без личных данных; `check-report.py` проверяет локальные пути и контрольные суммы. Конфиденциальные значения и бинарные изображения требуют отдельной проверки — один Gitleaks не заменяет визуальный просмотр.

Остановить выделенный контейнер после работы:

```bash
docker compose -f compose.yml stop browser
```

Рекомендации по инструментам: [Playwright Docker](https://playwright.dev/docs/docker), [установка headless shell](https://playwright.dev/docs/browsers). Это инструмент UI/UX-анализа; полный backend-набор тестов и приёмку доступности всеми способами он не заменяет.

Проверка опубликованного комплекта из корня репозитория:

```bash
python3 tools/ui-ux-audit/scripts/check-report.py
```
