# N6 на VPS 78.17.53.233

Каталог: `/home/rag-sales-chatbase`. Отдельный Compose-проект `rag-sales-chatbase`.
Применять `docker-compose.yml` **вместе с** `compose.vps.yml`.
`COMPOSE_FILE` в VPS-шаблоне также выбирает оба файла для обычного `docker compose`.
Старый `compose.stand.yml` относится к другой машине и здесь не используется.

## Окружение

Приватный `.env` уже подготовлен, права 0600; пароли PostgreSQL/Redis и секрет
сессий сгенерированы. Для нового профиля самостоятельно заполнить в `.env`:

- `DEEPSEEK_API_KEY` — ключ из https://platform.deepseek.com/ .
- `CLOUDRU_FM_API_KEY` — **Key Secret Foundation Models** Cloud.ru, не ключи S3.

Основной профиль уже выбран: `ANSWER_PROVIDER=deepseek`, `ANSWER_MODEL=deepseek-flash`,
`EMBED_PROVIDER=cloudru`, `EMBED_MODEL=openai/text-embedding-3-small`. Thinking выключен кодом.
`OPENROUTER_API_KEY` для гибрида не требуется. Значения ключей в чат и git не отправлять.
Ключи соседних проектов не копируются. `.env.vps.example` — публичный шаблон,
содержащий только несекретные настройки и пустые поля ключей.

Основной адрес с 2026-11-24: **https://sufler.site/**.
Прежний `https://rag-sales.78.17.53.233.sslip.io` перенаправляет на основной адрес (308, путь и query сохраняются).
Перенос домена: [проверки](domain-sufler-site-2026-11-24.md).
История первого запуска: [отчёт](launch-2026-11-18.md).
При выборе своего домена поменять `N6_PUBLIC_ORIGIN` и `deploy/vps/site.Caddyfile`.
14 квот, размерность 1536, порог и top-4 сохранены. ЮKassa выключена.

### Возврат к OpenRouter

Заполнить `OPENROUTER_API_KEY` и изменить в `.env`:

```dotenv
ANSWER_PROVIDER=openrouter
ANSWER_MODEL=anthropic/claude-haiku-4.5
EMBED_PROVIDER=openrouter
EMBED_MODEL=openai/text-embedding-3-small
```

Затем `bash scripts/vps.sh check` и `bash scripts/vps.sh up` (Compose пересоздаст изменённые сервисы).
Можно переключать ответы и эмбеддинги независимо; одного изменения ключа без провайдера недостаточно.
Автоматического fallback нет. При наличии старых индексов перед сменой embedding-шлюза проверить
совместимость векторов либо переиндексировать все источники; одинаковое имя/размерность не доказательство.
Cloud.ru 3-small — внешняя модель. Подробности: [ADR-024](../../docs/ADR.md).

## Изоляция и ресурсы

| Сервис | Лимит RAM | Примечание |
|---|---:|---|
| proxy | 96 МиБ | Модуль ограничения частоты сохранён |
| web | 640 МиБ | V8 heap до 384 МиБ |
| worker-index | 512 МиБ | V8 heap до 320 МиБ; штатная параллельность 1 |
| db | 384 МиБ | shared_buffers=64MB вместо 2GB, до 40 соединений |
| redis | 128 МиБ | maxmemory 64MB, noeviction и AOF |
| migrate | 256 МиБ | Одноразовый процесс перед web/worker |

Это ограничения контейнеров, не измеренное потребление под нагрузкой.
Журналы каждого контейнера ограничены 3 × 10 МБ.

Все данные проекта — в собственных Compose-томах. У db/redis/web/worker нет
host-портов и общей proxy-сети. Только дверь `proxy` подключена к `proofwall_default`
под уникальным alias `rag-sales-proxy`. Приложение имеет внутренний alias `rag-sales-web`;
дверь обращается именно к нему, чтобы общее имя `web` не разрешилось в соседний Proofwall.
Диагностический порт двери — только `127.0.0.1:8086`.

Внутренняя дверь доверяет XFF только точному адресу общего `proofwall-caddy-1`:
`N6_TRUSTED_PROXY_CIDR` с маской /32. После пересоздания общего Caddy адрес может
измениться; проверка запуска потребует обновить это поле. Внешний блок явно
заменяет XFF фактическим адресом соединения. Rate limit 30 мутаций/120 чтений
в минуту сохранён, исключение неизменяемой статики сохранено, CORS не добавляется.

## Проверка и запуск

```bash
cd /home/rag-sales-chatbase
bash scripts/vps.sh check
bash scripts/vps.sh up
bash scripts/vps.sh ps
bash scripts/vps.sh logs --tail 60
```

`check` не печатает разрешённый Compose с ключами: проверяет заполненность,
изоляцию, порт, RAM, журналы, read-only конфигурацию двери и фактический IP Caddy.
`up` использует уже собранные образы, не запускает фоновую сборку или pull.
До заполнения выбранных API-ключей VPS check/preflight откажут; это не обходится фиктивным значением.
Платные startup probes приложения происходят только при настоящем запуске.

Для последующей пересборки использовать отдельный ограниченный Buildx builder
и после сборки удалить его кэш. Пример (плагин Buildx установлен):

```bash
docker buildx create --name rag-sales-build --driver docker-container --driver-opt memory=1800m --driver-opt memory-swap=2600m
docker buildx build --builder rag-sales-build --load --target web -t n6-sufler-web:vps .
docker buildx build --builder rag-sales-build --load --target worker -t n6-sufler-worker:vps .
docker buildx build --builder rag-sales-build --load --target migrate -t n6-sufler-migrate:vps .
docker buildx build --builder rag-sales-build --load -f proxy/Dockerfile -t caddy:2.8-n6-ratelimit-vps proxy
docker buildx rm rag-sales-build
```

После успешного старта и проверки `/health` добавить `site.Caddyfile` в существующий
`/home/proofwall/deploy/sslip/Caddyfile`, проверить `caddy validate` и выполнить
`caddy reload` в `proofwall-caddy-1`. До этого новый маршрут в общий прокси не вносится.
Остальные блоки общего Caddy и работающие проекты сохраняются.

Сырые журналы сборки/проверок находятся в `.secrets/vps-adaptation/` и не публикуются.
Фактические выполненные проверки и ограничения записываются в `validation.md`.
