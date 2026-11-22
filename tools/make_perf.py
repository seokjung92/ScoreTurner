#!/usr/bin/env python3
"""시험용 가상 연주 만들기 (로컬 전용, 결과는 저장소 밖에 둘 것).
정답 JSON(gt_from_mxl.py 출력) → 연주 JSON {notes:[{t,dur,midi,vel}], timeline:[{t,page,sys}]}
  python3 -I tools/make_perf.py 정답.json 출력.json [--bpm 80] [--scenario clean|repeat|startmid] [--seed 1]
scenario
  clean    처음부터 끝까지 (놓침 5%, 틀림 3%, 박 흔들림)
  repeat   쪽마다 둘째 줄 중간에서 그 줄 처음으로 돌아가 다시 치고, 쪽을 넘긴 뒤 첫 줄을 마치면
           앞 쪽 마지막 줄로 돌아가 다시 침 (틀려서 다시 치는 연습)
  startmid 둘째 쪽 처음부터 침
"""
import json, random, sys, argparse

ap = argparse.ArgumentParser()
ap.add_argument('gt'); ap.add_argument('out')
ap.add_argument('--bpm', type=float, default=80)
ap.add_argument('--scenario', default='clean')
ap.add_argument('--seed', type=int, default=1)
ap.add_argument('--miss', type=float, default=0.05)
ap.add_argument('--wrong', type=float, default=0.03)
a = ap.parse_args()
rnd = random.Random(a.seed)
gt = json.load(open(a.gt))

# 정답 음 → 시각별 묶음 (붙임줄로 이어진 음은 다시 치지 않음)
notes = []
for pi, pg in enumerate(gt['pages']):
    for si, sy in enumerate(pg['systems']):
        for n in sy['notes']:
            notes.append(dict(n, page=pi, sys=si))
notes.sort(key=lambda n: n['t'])
groups = []
for n in notes:
    if groups and abs(groups[-1]['t'] - n['t']) < 1e-6:
        groups[-1]['notes'].append(n)
    else:
        groups.append({'t': n['t'], 'page': n['page'], 'sys': n['sys'], 'notes': [n]})
# 음 길이: 같은 단의 다음 음까지 (0.25~2박), 조금 길게(레가토)
for gi, g in enumerate(groups):
    for n in g['notes']:
        nxt = next((h['t'] for h in groups[gi + 1:] if any(m['staff'] == n['staff'] for m in h['notes'])), g['t'] + 1)
        n['dur'] = min(2.0, max(0.25, nxt - g['t'])) * 1.05

# 연주 순서 (묶음 번호 목록)
order = list(range(len(groups)))
if a.scenario == 'startmid':
    first = next((i for i, g in enumerate(groups) if g['page'] >= 1), 0)
    order = order[first:]
elif a.scenario == 'repeat':
    out = []
    pages = sorted(set(g['page'] for g in groups))
    done_restart = set(); done_back = set()
    i = 0
    while i < len(groups):
        g = groups[i]
        out.append(i)
        # 쪽 안 둘째 줄 중간 → 그 줄 처음으로
        sys_idx = [j for j, h in enumerate(groups) if h['page'] == g['page'] and h['sys'] == 1]
        if g['sys'] == 1 and sys_idx and i == sys_idx[len(sys_idx) // 2] and g['page'] not in done_restart:
            done_restart.add(g['page'])
            i = sys_idx[0]
            continue
        # 새 쪽 첫 줄을 마침 → 앞 쪽 마지막 줄 처음으로
        if g['page'] >= 1 and g['sys'] == 0 and (i + 1 >= len(groups) or groups[i + 1]['sys'] != 0 or groups[i + 1]['page'] != g['page']) and g['page'] not in done_back:
            done_back.add(g['page'])
            prev_last = max(h['sys'] for h in groups if h['page'] == g['page'] - 1)
            i = next(j for j, h in enumerate(groups) if h['page'] == g['page'] - 1 and h['sys'] == prev_last)
            continue
        i += 1
    order = out

beat = 60.0 / a.bpm
t = 1.0
outn, timeline = [], []
for k, gi in enumerate(order):
    g = groups[gi]
    if k > 0:
        prev = groups[order[k - 1]]
        step = g['t'] - prev['t']
        if step <= 0 or step > 4:  # 되돌아가기·건너뛰기: 잠깐 쉬고 다시
            step = 1.5
        t += step * beat
    tt = t + rnd.gauss(0, 0.012)
    played = []
    for n in g['notes']:
        if n.get('tied'):
            continue
        if rnd.random() < a.miss:
            continue
        m = n['midi'] + (rnd.choice([-1, 1]) if rnd.random() < a.wrong else 0)
        vel = int(max(30, min(110, rnd.gauss(72 if n['staff'] == 1 else 62, 10))))
        outn.append({'t': round(tt + rnd.gauss(0, 0.006), 4), 'dur': round(n['dur'] * beat, 4), 'midi': m, 'vel': vel})
        played.append(m)
    timeline.append({'t': round(tt, 4), 'page': g['page'], 'sys': g['sys'], 'n': len(played)})
json.dump({'bpm': a.bpm, 'scenario': a.scenario, 'notes': outn, 'timeline': timeline}, open(a.out, 'w'))
print(f"{a.out}: 묶음 {len(order)}개, 음 {len(outn)}개, 길이 {t + 2:.0f}초")
