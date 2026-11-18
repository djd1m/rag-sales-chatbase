#!/usr/bin/env python3
"""Регрессии условных ключей VPS check. Только локальные фиктивные значения."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('vps_config', Path(__file__).with_name('check-vps-config.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def services():
    embedding = {'EMBED_PROVIDER': 'cloudru', 'EMBED_MODEL': 'openai/text-embedding-3-small',
                 'CLOUDRU_FM_API_KEY': 'fixture-cloudru', 'OPENROUTER_API_KEY': ''}
    return {'web': {'environment': {**embedding, 'ANSWER_PROVIDER': 'deepseek',
             'ANSWER_MODEL': 'deepseek-flash', 'DEEPSEEK_API_KEY': 'fixture-deepseek'}},
            'worker-index': {'environment': copy.copy(embedding)}}


class ModelConfiguration(unittest.TestCase):
    def test_hybrid_without_openrouter(self):
        module.check_models(services())

    def test_all_provider_combinations(self):
        for answer in ['deepseek', 'openrouter']:
            for embed in ['cloudru', 'openrouter']:
                cfg = services()
                web = cfg['web']['environment']
                web['ANSWER_PROVIDER'] = answer
                web['ANSWER_MODEL'] = 'deepseek-flash' if answer == 'deepseek' else 'anthropic/claude-haiku-4.5'
                for service in cfg.values():
                    service['environment'].update(EMBED_PROVIDER=embed, OPENROUTER_API_KEY='fixture-or')
                module.check_models(cfg)

    def test_missing_selected_keys(self):
        for name in ['DEEPSEEK_API_KEY', 'CLOUDRU_FM_API_KEY']:
            cfg = services()
            cfg['web']['environment'][name] = ''
            with self.assertRaisesRegex(ValueError, name):
                module.check_models(cfg)

    def test_missing_openrouter_key_for_rollback(self):
        cfg = services()
        cfg['web']['environment'].update(ANSWER_PROVIDER='openrouter', ANSWER_MODEL='anthropic/claude-haiku-4.5')
        with self.assertRaisesRegex(ValueError, 'OPENROUTER_API_KEY'):
            module.check_models(cfg)

    def test_incompatible_pair(self):
        cfg = services()
        cfg['web']['environment']['ANSWER_MODEL'] = 'anthropic/claude-haiku-4.5'
        with self.assertRaisesRegex(ValueError, 'ANSWER_MODEL'):
            module.check_models(cfg)

    def test_embedding_mismatch_between_processes(self):
        cfg = services()
        cfg['worker-index']['environment']['EMBED_PROVIDER'] = 'openrouter'
        cfg['worker-index']['environment']['OPENROUTER_API_KEY'] = 'fixture-or'
        with self.assertRaises(ValueError):
            module.check_models(cfg)

    def test_deepseek_key_forbidden_in_worker(self):
        cfg = services()
        cfg['worker-index']['environment']['DEEPSEEK_API_KEY'] = 'fixture-deepseek'
        with self.assertRaisesRegex(ValueError, 'worker-index'):
            module.check_models(cfg)

    def test_invalid_dimension_model(self):
        cfg = services()
        cfg['web']['environment']['EMBED_MODEL'] = 'BAAI/bge-m3'
        with self.assertRaisesRegex(ValueError, 'EMBED_MODEL'):
            module.check_models(cfg)


class WebRouting(unittest.TestCase):
    def test_unique_alias_and_upstream(self):
        cfg = {'web': {'networks': {'default': {'aliases': ['rag-sales-web']}}}}
        module.check_web_route(cfg, 'reverse_proxy rag-sales-web:3000 {')

    def test_missing_alias_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'alias'):
            module.check_web_route({'web': {'networks': {'default': {}}}}, 'reverse_proxy rag-sales-web:3000 {')

    def test_shared_generic_web_is_rejected(self):
        cfg = {'web': {'networks': {'default': {'aliases': ['rag-sales-web']}}}}
        with self.assertRaisesRegex(ValueError, 'коллизия'):
            module.check_web_route(cfg, 'reverse_proxy web:3000 {')


if __name__ == '__main__':
    unittest.main()
