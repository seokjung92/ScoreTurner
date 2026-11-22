#!/usr/bin/env python3
"""정확도 측정용: (손으로 고친) MusicXML(.mxl)에서 쪽 → 줄 → 소리 나는 순서의 음 묶음을 JSON으로 뽑는다.

    python3 -I tools/gt_from_mxl.py 곡.mxl > 정답.json

줄·쪽 구분은 Audiveris가 남긴 <print new-system/new-page>를 따른다.
출력은 악보 내용(음 목록)이므로 저장소에 넣지 말 것 (개인 연습용 악보에서 나온 정보).
"""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

STEPS = "CDEFGAB"
SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def load_root(path):
    z = zipfile.ZipFile(path)
    names = [n for n in z.namelist() if n.endswith(".xml") and not n.startswith("META-INF")]
    return ET.fromstring(z.read(names[0]))


def main(path):
    root = load_root(path)
    parts = root.findall("part")
    # 2단(피아노) 파트를 고름. 없으면 첫 파트
    part = parts[0]
    for p in parts:
        st = p.find("measure/attributes/staves")
        if st is not None and st.text and int(st.text) >= 2:
            part = p
            break

    pages = []  # [{systems: [{measures: [..], events: [...]}]}]
    t = 0.0      # 곡 처음부터의 4분음표 수
    div = 1.0
    for mi, meas in enumerate(part.findall("measure")):
        pr = meas.find("print")
        new_page = pr is not None and pr.get("new-page") == "yes"
        new_sys = pr is not None and pr.get("new-system") == "yes"
        if not pages or new_page:
            pages.append({"systems": []})
        if not pages[-1]["systems"] or new_page or new_sys:
            pages[-1]["systems"].append({"measures": [], "notes": []})
        sysd = pages[-1]["systems"][-1]
        sysd["measures"].append(meas.get("number"))

        pos = 0.0
        mlen = 0.0
        last_start = 0.0
        for e in meas:
            if e.tag == "attributes":
                d = e.findtext("divisions")
                if d:
                    div = float(d)
            elif e.tag == "backup":
                pos -= float(e.findtext("duration")) / div
            elif e.tag == "forward":
                pos += float(e.findtext("duration")) / div
                mlen = max(mlen, pos)
            elif e.tag == "note":
                if e.find("grace") is not None:
                    continue
                dur = float(e.findtext("duration") or 0) / div
                chord = e.find("chord") is not None
                start = last_start if chord else pos
                if not chord:
                    last_start = pos
                    pos += dur
                    mlen = max(mlen, pos)
                p = e.find("pitch")
                if p is None:
                    continue
                if e.find("tie[@type='stop']") is not None and e.find("tie[@type='start']") is None:
                    tied = True
                else:
                    tied = e.find("tie[@type='stop']") is not None
                step = p.findtext("step")
                octv = int(p.findtext("octave"))
                alter = int(float(p.findtext("alter") or 0))
                staff = int(e.findtext("staff") or 1)
                sysd["notes"].append({
                    "t": round(t + start, 4),
                    "staff": staff,
                    "d": octv * 7 + STEPS.index(step),        # 오선 위치(음 이름 + 옥타브)
                    "midi": 12 * (octv + 1) + SEMI[step] + alter,
                    "tied": tied,                             # 붙임줄로 이어진 음 (새로 치지 않음)
                })
        t += mlen
    for pg in pages:
        for s in pg["systems"]:
            s["notes"].sort(key=lambda n: (n["t"], n["staff"], n["d"]))
    json.dump({"pages": pages}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1])
