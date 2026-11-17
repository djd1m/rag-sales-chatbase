#!/usr/bin/env bash
# Локальный VPS: оба compose-файла обязательны. Конфигурация с ключами не печатается.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
env_file="${N6_ENV_FILE:-.env}"
compose=(docker compose --env-file "$env_file" -f docker-compose.yml -f compose.vps.yml)
case "${1:-help}" in
  check|config)
    "${compose[@]}" config --quiet
    python3 scripts/check-vps-config.py "$env_file"
    ;;
  up)
    bash "$0" check
    # Миграции штатно применяются только к новому отдельному pgdata проекта.
    "${compose[@]}" up -d --no-build --pull never
    ;;
  ps|logs|stop)
    command="$1"; shift
    exec "${compose[@]}" "$command" "$@"
    ;;
  *)
    printf '%s\n' 'Использование: bash scripts/vps.sh check|up|ps|logs|stop' 'Сборка описана в deploy/vps/README.md. Ключи: .env, содержимое не печатается.'
    exit 0
    ;;
esac
