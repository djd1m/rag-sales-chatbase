# Нативный DeepSeek + Cloud.ru FM с возвратом к OpenRouter

Дата: 2026-11-18. Основание: владелец поручил реализовать гибрид с сохранением OpenRouter.

## PLAN

1. Разделить ответ/эмбеддинг закрытыми ANSWER_PROVIDER (deepseek/openrouter), EMBED_PROVIDER
   (cloudru/openrouter), моделями и отдельными ключами. Адреса API фиксированы в коде.
2. Сохранить OpenRouter Chat Completions; DeepSeek использовать через Responses API с JSON Schema,
   reasoning.effort=none, максимум 400 output tokens, temperature=0, timeout=20s.
3. Cloud.ru /v1/embeddings: тот же openai/text-embedding-3-small, dimensions=1536. Проверить число,
   размерность, конечность элементов и индекс каждого вектора. Модель поиска не меняется.
4. Перевести web/worker и пробы на общий клиент. Квоты, meteredCall, citations/unknown неизменны.
   Автоматического fallback между провайдерами нет; возврат — явная конфигурация и рестарт.
5. Обновить Compose, env-шаблоны, приватный .env (только настройки/пустые новые ключи), VPS check,
   ADR/canon и инструкции. Проверить без реальных ключей; платные вызовы не выполнять.
6. Проверки: конфигурация и несовместимые пары; протокол/маршрутизация/изоляция ключей;
   отказы/таймауты/неполный ответ/переставленные эмбеддинги; запуск обеих проб; RAG-барьеры;
   lint/typecheck/build, полный локальный набор с временными DB/Redis. Независимое ревью.

## VALIDATE

Риски: Chat API DeepSeek не принимает текущий OpenRouter json_schema payload, поэтому используется
Responses /responses с text.format {type:json_schema,name,schema}; strict не добавляется.
Cloud.ru FM Key Secret отличается от S3. Смена шлюза той же embedding-модели не доказывает
численную идентичность векторов: существующий индекс переносить только после сравнения/переиндексации.
В этом новом VPS-стеке пользовательских индексов ещё нет. Совместимость реального API и качество
ответов остаются отдельным живым замером после ввода ключей. Новые Qwen/BGE модели и миграция
размерности не входят в задачу.

Переиспользование ADR-012: OpenRouter transport/errors, meteredCall и quota перенесены/адаптированы;
DeepSeek Responses и Cloud.ru маршрут написаны заново из-за разных контрактов. Миграции БД не нужны.

Моно-репозиторные ../../.claude и ../../scripts/complexity-router.sh в standalone checkout отсутствуют:
их проверки не заявляются выполненными. План и валидация зафиксированы здесь до реализации;
текущий запрос владельца уже разрешает изменение провайдеров, повторное согласование не нужно.

Источники: https://api-docs.deepseek.com/api/create-response/ ;
https://cloud.ru/docs/foundation-models/ug/topics/api-ref__authentication ;
публичный https://foundation-models.api.cloud.ru/v1/models (endpoint embeddings и модель).
