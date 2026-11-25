# r6 опубликован на sufler.site

Фактическое завершение: **2026-11-25T23:38:55.947855+00:00**. Адрес: https://sufler.site/ . Web и worker-index — healthy, точный image ID `sha256:0a2aef6dac145ca7a7e05b8beea0e3a58d365e9fc1e670500ba2d6cc866713cd`, Next BUILD_ID `IBENpJ0gdNkszBBvbuNFL`. Исходники приложения `d1089c47d0f083f922a7d87fc512eb8e72aa3f57`; normal fast-forward в main — `8cca07d3a1c47ceac40134e15e5dbc19cdb9dfab`. Последующий коммит добавляет только эту документацию.

## Выполненный выпуск

- До миграций создан приватный custom PostgreSQL archive. Проверены список с данными account, сухая генерация SQL через pg_restore в /dev/null и SHA-256. Реальные данные архива не опубликованы и восстановление поверх рабочей базы не выполнялось.
- Аддитивные 016_customer_trust_identity_legal и 017_customer_trust_billing применены и прочитаны из migration ledger, с lock timeout 5 s / statement timeout 75 s. Затем последовательно обновлены worker и web без сборки/скачивания образов.
- Проверены точные image/BUILD_ID и health. DB, Redis и proxy сохранили container ID и StartedAt; Caddy/DNS/другие проекты не менялись. Прежние образы и команды сохранены для отката приложения без отката совместимых миграций и без потери новых записей.
- **10/10** проверок настоящего HTTPS с обычной проверкой сертификата дали HTTP 200: health, главная, login, pricing, terms, privacy, consent, cookies, offer, support. Это anonymous GET smoke, а не вход в реальные аккаунты или новый платный RAG-запрос.
- Сохранены существующие настройки DeepSeek/Cloud.ru и возможность выбора OpenRouter. Штатные preflight-пробы существующих модельных провайдеров выполняются при старте; ноль всех production paid calls не заявляется.

## Проверки перед публикацией

Полный актуальный набор **1280/1280**, 77 файлов, без skips, test/cleanup exit 0. Свежие три пары нагрузки завершены exit 0; raw SHA `76a54c30886550fa1da90a9e2d1d92ff4b6f7a7a294ecfb19310478597d34aa7`, все источники и runtime до/после совпали. [Измерения](load-validation.md), [покрытие](coverage-validation.md), [compiled границы](runtime-boundary-validation.md). Оба native циклы 2 и 3 закрыты исходными ролями, Step 8/9 пройдены; предыдущие FAIL не переписаны.

Новые Resend, ЮKassa/чеки и Libredesk **выключены**. Их включение требует ключей и уже описанных проверок реального магазина, доставки и раздельной истории inbox. Пять пользовательских сессий исследования тарифов не проводились. Границы Chromium, синтетики, observed coverage, generic guard HARD false positive и неустановленных автоматических Codex hooks явно сохранены в Step 8/9. GitHub CI не добавлялся.

## Следующие операции на этом VPS

Применённый артефакт — один проверенный локальный образ с **явными production-командами и NODE_ENV=production**. Для обслуживания использовать приватный wrapper текущего выпуска:

```bash
.secrets/deployment/compose-r6.sh ps
.secrets/deployment/compose-r6.sh up -d --no-deps --no-build --pull never --wait --wait-timeout 110 web worker-index
```

Он включает docker-compose.yml + compose.vps.yml + приватный compose.override.json с точным образом и командами. Простой базовый `up` способен вернуть старые теги; переименование test-образа под старый web-tag не заменяет production-команду. Wrapper и backup/rollback сведения находятся на VPS, секретов в публичном протоколе нет. Перед новым выпуском нужно подготовить и проверить его собственный overlay/артефакт.
