#!/usr/bin/env python3
"""Reproduce the research, not application billing. Python 3, standard library."""
from decimal import Decimal as D, getcontext
from pathlib import Path
import csv
import json
from itertools import product

getcontext().prec = 32
ROOT = Path(__file__).resolve().parent
M = D(1_000_000)
FX = D('82.1664')
EMBED = D('3.933')
FEE = D('0.0427')  # hypothetical, not the merchant's verified contract
PARTNER = D('0.20')
INDEX_RESERVE = D('1.15')
FIXED = D('3000')  # scenario budget for shared infrastructure, not an invoice/capacity proof


def text(value):
    return format(value, 'f') if isinstance(value, D) else value


def money(value):
    return format(value.quantize(D('0.01')), 'f')


def unit(inp, out, query, peak, fx, reserve):
    input_rate = D('.15') * (1 - peak) + D('.30') * peak
    output_rate = D('.60') * (1 - peak) + D('1.20') * peak
    raw = (D(inp) * input_rate + D(out) * output_rate) / M * fx + D(query) / M * EMBED
    return {'input': inp, 'output': out, 'question_embedding': query,
            'peak_fraction': peak, 'fx_rub_usd': fx, 'reserve': reserve,
            'raw_rub': raw, 'reserved_rub': raw * reserve}


units = {
    'short_mixed': unit(2000, 300, 50, D('.25'), FX, D('1.15')),
    'planning_base': unit(3000, 300, 100, D(1), FX, D('1.15')),
    'planning_stress': unit(6000, 400, 250, D(1), D(100), D('1.30')),
}
assert units['planning_base']['reserved_rub'] == D('0.11951140860')
assert units['planning_stress']['reserved_rub'] == D('0.297678225')
RATES = {'base': D('.12'), 'stress': D('.30')}  # rounded upward planning budgets
assert all(RATES[k] >= units['planning_' + k]['reserved_rub'] for k in RATES)

# index_million is assumed consumption of BILLABLE tokens, not an existing monthly cap.
PLANS = [
    dict(id='current_solo', scheme='current', price=990, bots=1, questions=3000, index_million=5, support=250),
    dict(id='current_studio', scheme='current', price=4900, bots=10, questions=30000, index_million=30, support=1500),
    dict(id='candidate_solo', scheme='candidate', price=1990, bots=1, questions=3000, index_million=5, support=250),
    dict(id='candidate_studio', scheme='candidate', price=9990, bots=10, questions=15000, index_million=30, support=1500),
    dict(id='alternative_entry', scheme='alternative', price=1490, bots=1, questions=1500, index_million=5, support=250),
    dict(id='alternative_price_only', scheme='alternative', price=1490, bots=1, questions=3000, index_million=5, support=250),
    dict(id='not_selected_middle', scheme='not_selected', price=4990, bots=3, questions=6000, index_million=15, support=500),
]


def net(price, partner):
    return D(price) * (1 - FEE) * (1 - partner)


def account_cost(plan, rate, utilization=D(1), question_multiplier=D(1)):
    # Index and support remain fixed at scenario amounts; only answer usage scales.
    return (D(plan['questions']) * utilization * question_multiplier * rate
            + D(plan['index_million']) * EMBED * INDEX_RESERVE + D(plan['support']))


plan_rows = []
for plan, workload, channel, utilization in product(PLANS, RATES, ['direct', 'partner'], [D('.25'), D('.50'), D(1)]):
    rate = RATES[workload]
    partner = PARTNER if channel == 'partner' else D(0)
    contribution = net(plan['price'], partner) - account_cost(plan, rate, utilization)
    plan_rows.append({**plan, 'workload': workload, 'channel': channel, 'utilization': utilization,
                      'question_cost_rub': rate, 'net_receipts_rub': net(plan['price'], partner),
                      'cost_rub': account_cost(plan, rate, utilization),
                      'contribution_before_fixed_tax_cac_rub': contribution,
                      'contribution_pct_gross': contribution / D(plan['price']) * 100,
                      'after_hypothetical_6pct_gross_rub': contribution - D(plan['price']) * D('.06')})
assert len(plan_rows) == 84

# Nominal cohort economics, including unattainable cases explicitly flagged for capacity.
cohort_rows = []
for scheme, active, conversion, use, workload, channel in product(
        ['current', 'candidate'], [100, 1000], [D('.05'), D('.10'), D('.20')],
        [D('.25'), D('.50'), D(1)], RATES, ['direct', 'partner']):
    solo, studio = [p for p in PLANS if p['scheme'] == scheme]
    paid = D(active) * conversion
    # 20% studio mix uses expected account counts; fractional counts are planning averages.
    studios, solos = paid * D('.20'), paid * D('.80')
    free = D(active) - paid
    questions = (solos * solo['questions'] + studios * studio['questions'] + free * 300) * use
    paid_questions = (solos * solo['questions'] + studios * studio['questions']) * use
    gross = solos * solo['price'] + studios * studio['price']
    partner = PARTNER if channel == 'partner' else D(0)
    paid_cost = solos * account_cost(solo, RATES[workload], use) + studios * account_cost(studio, RATES[workload], use)
    # Each free account: one million indexing tokens/month, no allocated human support.
    free_cost = free * (D(300) * use * RATES[workload] + EMBED * INDEX_RESERVE)
    residual = net(gross, partner) - paid_cost - free_cost - FIXED
    cohort_rows.append(dict(scheme=scheme, active_accounts=active, paid_fraction=conversion,
        expected_paid_accounts=paid, expected_studio_accounts=studios, utilization=use,
        workload=workload, channel=channel, gross_revenue_rub=gross,
        net_receipts_rub=net(gross, partner), paid_variable_and_support_rub=paid_cost,
        recurring_free_cost_rub=free_cost, assumed_fixed_rub=FIXED,
        residual_before_tax_cac_other_rub=residual,
        after_hypothetical_6pct_gross_rub=residual-gross*D('.06'),
        paid_questions=paid_questions, total_questions=questions,
        nominal_average_questions_day=questions/D(30),
        exceeds_current_global_3000_day_average=questions > D(90000),
        capacity_status='exceeds_current_quota' if questions > D(90000) else 'within_average_quota_only_not_load_tested'))
assert len(cohort_rows) == 144

boundary_rows = []
for plan, workload in product(PLANS[:2], RATES):
    cost = account_cost(plan, RATES[workload], question_multiplier=D(2))
    boundary_rows.append(dict(id=plan['id'], price=plan['price'], workload=workload,
        nominal_questions_per_payment=2*plan['questions'], cost_rub=cost,
        contribution_partner_before_fixed_tax_cac_rub=net(plan['price'], PARTNER)-cost))


def write_csv(name, rows):
    with (ROOT / name).open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows({k: text(v) for k,v in row.items()} for row in rows)


write_csv('plan-sensitivity.csv', plan_rows)
write_csv('cohort-sensitivity.csv', cohort_rows)
write_csv('calendar-boundary.csv', boundary_rows)
payload = dict(fx_rub_usd=FX, embedding_rub_million_including_vat=EMBED,
    units=units, planning_rates=RATES, plans=PLANS,
    assumptions=dict(acquiring_fraction=FEE, partner_fraction_net=PARTNER,
        indexing_reserve=INDEX_RESERVE, infrastructure_budget=FIXED,
        free_index_million=1, studio_share_paid=D('.20'),
        support_rub_hour=1500, tax_sensitivity_gross_fraction=D('.06')),
    plan_rows=plan_rows, cohort_rows=cohort_rows, calendar_boundary_rows=boundary_rows)
(ROOT / 'economics.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=text)+'\n')

md = ['# Воспроизводимый пересчёт', '',
      'Все суммы — сценарии, не фактическая прибыль. `python3 calculate.py` пересоздаёт JSON, CSV и эту сводку.', '',
      'Квотируемый вопрос в расчёте доходит до генератора; кэш не учитывается. Small talk и часть unknown дешевле. Входные токены — допущение, не измеренный максимум.', '',
      '| Сценарий вопроса | API, ₽ | С резервом, ₽ | Принято для пакетов, ₽ |',
      '|---|---:|---:|---:|']
for key, value in units.items():
    planned = RATES.get(key.replace('planning_', ''), '')
    md.append(f"| {key} | {value['raw_rub']:.8f} | {value['reserved_rub']:.8f} | {planned} |")
md += ['', '## Полное использование, партнёрский канал', '',
       'После условных 4,27% эквайринга, 20% партнёру с остатка, индексации и поддержки. До общей инфраструктуры, налогов, CAC и других расходов.', '',
       '| Вариант | Цена | Вопросов | База, ₽ | Стресс, ₽ | Стресс после условных 6% выручки, ₽ |',
       '|---|---:|---:|---:|---:|---:|']
for p in PLANS:
    rows = {r['workload']:r for r in plan_rows if r['id']==p['id'] and r['channel']=='partner' and r['utilization']==1}
    md.append(f"| {p['id']} | {p['price']} | {p['questions']} | {money(rows['base']['contribution_before_fixed_tax_cac_rub'])} | {money(rows['stress']['contribution_before_fixed_tax_cac_rub'])} | {money(rows['stress']['after_hypothetical_6pct_gross_rub'])} |")
md += ['', '## Календарная граница текущих тарифов', '',
       '30-дневная оплата может захватить части двух календарных месяцев и два месячных лимита. Это отдельный сценарий, не обычный ежемесячный расход и не строгий предел всех обходов. Нужны достаточные свободные дневные квоты с обеих сторон границы.', '',
       '| Текущий вариант | Вопросов за оплату | Сценарий | Вклад после партнёра/поддержки/индексации, ₽ |',
       '|---|---:|---|---:|']
for r in boundary_rows:
    md.append(f"| {r['id']} | {r['nominal_questions_per_payment']} | {r['workload']} | {money(r['contribution_partner_before_fixed_tax_cac_rub'])} |")
md += ['', '## Когорты: партнёрский канал, 10% платящих и полное потребление', '',
       'Среди платящих 80% одиночных сайтов и 20% студий. Free остаётся ежемесячным (300 вопросов), не превращается в разовый trial. На Free заложен 1 млн токенов индексации; поддержки Free в модели нет. 3 000 ₽ — условный общий месячный инфраструктурный бюджет, не текущий счёт VPS. Стоимость поддержки платящих не уменьшается при низком расходе вопросов.', '',
       '| Сетка | Активных | База, ₽ | Стресс, ₽ | Вопросов/день в среднем | Относительно текущей общей квоты |',
       '|---|---:|---:|---:|---:|---|']
for scheme, active in product(['current','candidate'], [100,1000]):
    rows = {r['workload']:r for r in cohort_rows if r['scheme']==scheme and r['active_accounts']==active and r['paid_fraction']==D('.10') and r['utilization']==1 and r['channel']=='partner'}
    b,s=rows['base'],rows['stress']
    flag='Превышает; сценарий не обеспечен текущими лимитами' if b['exceeds_current_global_3000_day_average'] else 'Только средняя квота; ёмкость не доказана'
    md.append(f"| {scheme} | {active} | {money(b['residual_before_tax_cac_other_rub'])} | {money(s['residual_before_tax_cac_other_rub'])} | {money(b['nominal_average_questions_day'])} | {flag} |")
md += ['', 'CSV: 84 строки пакетов, 144 когорты, 4 календарных сценария. Это номинальный спрос до технических отказов: после достижения потолка реальные ответы и расходы будут меньше. Выручка при таком качестве обслуживания также не гарантирована. Предпросмотр, startup-пробы, возвраты, хранение, резервные копии, почта, CAC и налоги не включены в остаток; отдельная колонка 6% — лишь иллюстрация чувствительности, не налоговый расчёт владельца.', '']
(ROOT / 'sensitivity.md').write_text('\n'.join(md))
print('Generated 84 plan, 144 cohort and 4 calendar-boundary scenarios; Decimal identities passed.')
