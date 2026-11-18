#!/usr/bin/env python3
"""Проверка эффективной конфигурации VPS без вывода значений секретов."""
import ipaddress
import json
from pathlib import Path
import socket
import subprocess
import sys


def check_models(services):
    web = services['web']['environment']
    worker = services['worker-index']['environment']
    answers = {'deepseek': ('deepseek-flash', 'DEEPSEEK_API_KEY'),
               'openrouter': ('anthropic/claude-haiku-4.5', 'OPENROUTER_API_KEY')}
    embeddings = {'cloudru': 'CLOUDRU_FM_API_KEY', 'openrouter': 'OPENROUTER_API_KEY'}
    if web.get('ANSWER_PROVIDER') not in answers:
        raise ValueError('ANSWER_PROVIDER: допустимы deepseek или openrouter')
    model, key = answers[web['ANSWER_PROVIDER']]
    if web.get('ANSWER_MODEL') != model:
        raise ValueError('ANSWER_MODEL не соответствует ANSWER_PROVIDER')
    selected_keys = [(web, key)]
    for env in [web, worker]:
        provider = env.get('EMBED_PROVIDER')
        if provider not in embeddings:
            raise ValueError('EMBED_PROVIDER: допустимы cloudru или openrouter')
        if env.get('EMBED_MODEL') != 'openai/text-embedding-3-small':
            raise ValueError('EMBED_MODEL: требуется openai/text-embedding-3-small (1536)')
        selected_keys.append((env, embeddings[provider]))
    for env, name in selected_keys:
        value = env.get(name, '')
        if not value or any(char.isspace() for char in value):
            raise ValueError(name + ': заполните ключ выбранного провайдера в .env')
    for name in ['EMBED_PROVIDER', 'EMBED_MODEL', 'CLOUDRU_FM_API_KEY', 'OPENROUTER_API_KEY']:
        if web.get(name) != worker.get(name):
            raise ValueError('Конфигурация эмбеддингов web/worker различается: ' + name)
    if worker.get('DEEPSEEK_API_KEY'):
        raise ValueError('Ключ ответов DeepSeek не должен передаваться worker-index')


def check(env_file):
    result = subprocess.run(
        ['docker', 'compose', '--env-file', env_file, '-f', 'docker-compose.yml',
         '-f', 'compose.vps.yml', 'config', '--format', 'json'],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError('Compose не прошёл проверку; проверьте заполнение .env')
    cfg = json.loads(result.stdout)
    if cfg['name'] != 'rag-sales-chatbase':
        raise ValueError('Для этого VPS ожидается отдельный N6_COMPOSE_PROJECT=rag-sales-chatbase')
    services = cfg['services']
    check_models(services)
    for name in ['web', 'worker-index', 'db', 'redis', 'migrate']:
        if services[name].get('ports'):
            raise ValueError('Порт приложения или хранилища опубликован мимо proxy: ' + name)
        if set(services[name].get('networks', {})) != {'default'}:
            raise ValueError('Лишняя сеть у внутреннего сервиса: ' + name)
    mounted = next((v for v in services['proxy'].get('volumes', []) if v['target'] == '/etc/caddy/Caddyfile'), None)
    expected_config = str((Path(__file__).resolve().parents[1] / 'deploy/vps/proxy.Caddyfile').resolve())
    if not mounted or mounted.get('source') != expected_config or mounted.get('read_only') is not True:
        raise ValueError('Дверь не использует отдельный read-only Caddyfile этого VPS')
    ports = services['proxy'].get('ports', [])
    if len(ports) != 1 or ports[0].get('host_ip') != '127.0.0.1':
        raise ValueError('Дверь должна публиковаться только на 127.0.0.1')
    aliases = services['proxy']['networks']['vps-proxy']['aliases']
    if aliases != ['rag-sales-proxy'] or cfg['networks']['vps-proxy']['name'] != 'proofwall_default':
        raise ValueError('Неверная сеть или alias общего прокси')
    trusted = services['proxy']['environment']['N6_TRUSTED_PROXY_CIDR']
    network = ipaddress.ip_network(trusted)
    if network.version != 4 or network.prefixlen != 32:
        raise ValueError('Доверие XFF должно быть ограничено одним IPv4 (/32)')
    current = json.loads(subprocess.check_output(['docker', 'inspect', 'proofwall-caddy-1'], text=True))
    current_ip = current[0]['NetworkSettings']['Networks']['proofwall_default']['IPAddress']
    if str(network.network_address) != current_ip:
        raise ValueError('Адрес общего Caddy изменился: обновите N6_TRUSTED_PROXY_CIDR в .env')
    limits = {'proxy': 96, 'web': 640, 'worker-index': 512, 'migrate': 256, 'db': 384, 'redis': 128}
    for name, mib in limits.items():
        if int(services[name].get('mem_limit', 0)) != mib * 1024 * 1024:
            raise ValueError('Неверный лимит памяти: ' + name)
        options = services[name].get('logging', {}).get('options', {})
        if options != {'max-size': '10m', 'max-file': '3'}:
            raise ValueError('Журналы не ограничены: ' + name)
    if 'shared_buffers=64MB' not in services['db']['command']:
        raise ValueError('Буфер PostgreSQL не уменьшен до 64MB')
    # Действующие project-контейнеры не считаются конфликтом сами с собой.
    port = int(ports[0]['published'])
    running = subprocess.check_output(['docker', 'ps', '--filter', 'label=com.docker.compose.project=rag-sales-chatbase', '--filter', 'label=com.docker.compose.service=proxy', '-q'], text=True).strip()
    if not running:
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
            except OSError as error:
                raise ValueError('Порт двери уже занят: ' + str(port)) from error
    print('VPS config: изоляция, порты, точное доверие XFF, память и ротация журналов проверены.')


if __name__ == '__main__':
    try:
        check(sys.argv[1] if len(sys.argv) > 1 else '.env')
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print('VPS config: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
