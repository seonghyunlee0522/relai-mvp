#!/usr/bin/env python3
"""
PM knowledge source → section chunks (JSONL) for scripts/kb/build-cards.mjs.

Built for the PMBOK-6-structured Korean study guide (numbered sections "9.5.3 팀 관리: 산출물", one chapter per knowledge area).
Output stays OUTSIDE the repository: source text is reference material for card generation only and is never committed,
never loaded into the database and never shown to users.

  python3 -I scripts/kb/extract_pdf.py <source.pdf> <out.jsonl> [--doc-key pmbok6-guide]

Skipped: front matter / table of contents, chapter cover pages, 예상 문제 · 답과 해설 (exam drills), appendices (glossary).
Chunk = one 3-level section (x.y.z); long sections split at paragraph boundaries (~2,800 chars), tiny ones merged into the previous
chunk of the same 2-level section.
"""
import json, re, sys, hashlib
import pymupdf

CHAPTERS = {
    1: ('서론', 'FOUNDATION'), 2: ('프로젝트 운영 환경', 'FOUNDATION'), 3: ('프로젝트 관리자의 역할', 'FOUNDATION'),
    4: ('통합관리', 'INTEGRATION'), 5: ('범위관리', 'SCOPE'), 6: ('일정관리', 'SCHEDULE'), 7: ('원가관리', 'COST'),
    8: ('품질관리', 'QUALITY'), 9: ('자원관리', 'RESOURCE'), 10: ('의사소통관리', 'COMMUNICATIONS'), 11: ('리스크관리', 'RISK'),
    12: ('조달관리', 'PROCUREMENT'), 13: ('이해관계자관리', 'STAKEHOLDER'),
}
HEAD = re.compile(r'^(\d{1,2})\.(\d{1,2})\.(\d{1,2})\s+(\S.{0,80})$')
SECT = re.compile(r'^(\d{1,2})-(\d{1,2})(?:\s+\S.{0,80})?$', re.M)
CH_MARK = re.compile(r'^Chapter\s+(\d{1,2})\s*$', re.M)
MAX_CHARS, MIN_CHARS = 2800, 400

def clean(t):
    t = t.replace(' ', ' ').replace('\x07', '').replace('﻿', '')
    t = re.sub(r'[-]', '', t)               # private-use glyphs (®, bullets) from the InDesign fonts
    out = []
    for ln in t.split('\n'):
        s = ln.strip()
        if not s or s in ('☞',) or re.fullmatch(r'\d{1,3}', s) or re.fullmatch(r'Chapter\s+\d{1,2}', s) or re.fullmatch(r'부록\s*\d*', s): continue
        out.append(s)
    return out

def main(src, dst, doc_key):
    doc = pymupdf.open(src)
    pages = [p.get_text() for p in doc]
    # page → chapter (running header "Chapter N"); exam pages and appendices are dropped
    chapter, skip, in_exam = 0, set(), False
    page_ch = {}
    for i, t in enumerate(pages):
        head = t[:250]
        m = CH_MARK.search(t)
        if m and int(m.group(1)) != chapter: chapter = int(m.group(1)); in_exam = False
        first_sect = SECT.search('\n'.join(clean(t)[:6]))
        if first_sect and first_sect.group(2) == '1' and int(first_sect.group(1)) != chapter: chapter = int(first_sect.group(1))
        if '예상 문제' in head or '답과 해설' in head: in_exam = True
        elif first_sect: in_exam = False
        if i < 14 or in_exam or '부록' in head or chapter == 0 or chapter > 13: skip.add(i)
        page_ch[i] = chapter
    chunks, cur = [], None
    def flush():
        if cur and len(' '.join(cur['lines'])) >= 80: chunks.append(cur)
    last_ch, pending_sect = None, None
    for i, t in enumerate(pages):
        if i in skip: continue
        ch_now = page_ch[i]
        if ch_now != last_ch:   # chapter intro (roadmap, overview) is its own chunk, never the tail of the previous chapter
            flush(); last_ch = ch_now
            cur = {'section': f'{ch_now}.0.0', 'title': f'{CHAPTERS[ch_now][0]} 개요', 'chapter': ch_now, 'page': i + 1, 'lines': []}
        for ln in clean(t):
            s = SECT.match(ln)
            if s and int(s.group(1)) == ch_now:   # "9-1" process heading (title may be on the next line): process overview chunk
                flush(); pending_sect = True
                cur = {'section': f'{s.group(1)}.{s.group(2)}.0', 'title': ln.split(None, 1)[1].strip() if len(ln.split(None, 1)) > 1 else '', 'chapter': ch_now, 'page': i + 1, 'lines': []}
                continue
            if pending_sect and cur and not cur['title']:
                cur['title'] = ln; pending_sect = False; continue
            pending_sect = False
            h = HEAD.match(ln)
            if h and int(h.group(1)) == page_ch[i] and len(h.group(4)) > 1 and not re.match(r'^\d', h.group(4)):
                flush()
                ch = int(h.group(1))
                cur = {'section': f'{h.group(1)}.{h.group(2)}.{h.group(3)}', 'title': re.sub(r'(?<=[가-힣])([A-Z][A-Za-z’\' ,&-]+)$', '', h.group(4)).strip(),
                       'chapter': ch, 'page': i + 1, 'lines': []}
                continue
            if cur is None: continue
            cur['lines'].append(ln)
    flush()
    # merge tiny chunks, split long ones
    merged = []
    for c in chunks:
        text = '\n'.join(c['lines'])
        if merged and len(text) < MIN_CHARS and merged[-1]['section'].rsplit('.', 1)[0] == c['section'].rsplit('.', 1)[0] and len(merged[-1]['text']) < MAX_CHARS:
            merged[-1]['text'] += f"\n[{c['section']} {c['title']}]\n{text}"; continue
        merged.append({**{k: c[k] for k in ('section', 'title', 'chapter', 'page')}, 'text': text})
    out = []
    for c in merged:
        parts, buf = [], ''
        for para in c['text'].split('\n'):
            if len(buf) + len(para) > MAX_CHARS and len(buf) > MIN_CHARS: parts.append(buf); buf = ''
            buf += para + '\n'
        if buf.strip():
            if parts and len(buf) < MIN_CHARS: parts[-1] += buf   # no tiny tail part
            else: parts.append(buf)
        for n, p in enumerate(parts):
            name, area = CHAPTERS[c['chapter']]
            c['title'] = re.sub(r'\s*\+\s*6판.*$', '', c['title']).strip()
            body = p.strip()
            out.append({'doc_key': doc_key, 'chunk_key': f"{c['section']}#{n + 1}", 'section': c['section'], 'title': c['title'], 'chapter': c['chapter'],
                        'chapter_name': name, 'knowledge_area': area, 'page': c['page'], 'text': body,
                        'hash': hashlib.sha256(body.encode()).hexdigest()[:16]})
    with open(dst, 'w', encoding='utf-8') as f:
        for o in out: f.write(json.dumps(o, ensure_ascii=False) + '\n')
    print(f'pages {len(pages)} (skipped {len(skip)}), chunks {len(out)}, chars {sum(len(o["text"]) for o in out):,}')

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    key = sys.argv[sys.argv.index('--doc-key') + 1] if '--doc-key' in sys.argv else 'pmbok6-guide'
    if len(args) < 2: sys.exit(__doc__)
    main(args[0], args[1], key if '--doc-key' not in args else key)
