# PM 지식 RAG — RELAI에게 물어보기

'RELAI에게 물어보기'(PROJECT_QA)가 프로젝트 데이터에 더해 PM 실무 지식을 배경으로 답한다. 결정 사항(2026-10-28):

- 원문 자료(PM 참고서 등)는 **참고용**으로만 쓴다. 답변에 **출처를 표시하지 않는다**.
- DB에는 원문을 넣지 않는다. 원문을 LLM으로 다시 쓴 **지식 카드**만 저장한다. 카드를 만들 때 원문과 연속 8어절 이상 겹치면 다시 쓰게 하고, 그래도 겹치면 버린다.
- 원문, 청크, 카드 파일은 저장소에 커밋하지 않는다(로컬 작업 폴더에서만 다룸).

## 구조

```
[오프라인, 운영자 PC]
PDF ─extract_pdf.py─▶ chunks.jsonl ─build-cards.mjs (LLM 재서술 + 원문 중복 검사)─▶ cards.jsonl
    ─load-cards.mjs (임베딩)─▶ kb_documents / kb_cards (DB)

[요청 시, server/ai/knowledge.js]
질문 ─▶ 질문 임베딩 + 키워드(한국어 bigram, idf) ─▶ 상위 5장 (같은 절 최대 2장, 현재 단계 가중 +0.03)
     ─▶ PROJECT_QA 프롬프트의 <pm_knowledge> 블록 (<project_data> 뒤, 질문 앞)
```

- 프로젝트 사실(일정·건수·상태)은 계속 `<project_data>`로만 답한다. 지식은 방법·개념 질문에 배경으로 쓰고, 문장을 그대로 옮기거나 출처를 언급하지 않는다. 이 규칙은 관리자가 고칠 수 있는 시스템 프롬프트가 아니라, 지식 블록이 있을 때만 붙는 사용자 메시지 끝 지시문에 있다. 그래서 관리자가 PROJECT_QA 프롬프트를 고쳐도 유지된다.
- 어떤 카드가 쓰였는지는 `ai_runs.input_summary`의 `kb vector 5.4.2#1.1,…`에 남는다(운영자 전용, 사용자 응답에는 없음).
- 검색에 실패해도 질문은 실패하지 않는다. 키가 없거나 임베딩이 타임아웃되면 키워드 검색으로, 카드가 없으면 기존 동작으로 돌아간다. 관리자 프롬프트 미리보기는 네트워크를 쓰지 않는 키워드 검색이다.
- 카드는 프로세스 메모리에서 코사인으로 계산한다(`real[]` 컬럼, 확장 불필요). 카드가 수만 장 규모로 커지면 pgvector로 옮긴다.

## 문서 추가·갱신 절차

작업 폴더는 저장소 밖(예: `~/relai-kb/`)으로 잡는다. 필요한 환경변수: `OPENAI_API_KEY`, `DATABASE_URL`(운영 DB).

```bash
pip install pymupdf
python3 -I scripts/kb/extract_pdf.py "<원본.pdf>" ~/relai-kb/chunks.jsonl --doc-key pmbok6-guide
node scripts/kb/build-cards.mjs --in ~/relai-kb/chunks.jsonl --out ~/relai-kb/cards.jsonl      # 이어하기 가능, 약 US$0.3
node scripts/kb/load-cards.mjs --in ~/relai-kb/cards.jsonl --doc-key pmbok6-guide --title "PM 참고서 (PMBOK 6 해설)"
node scripts/kb/eval.mjs                                                                         # hit@1 / hit@5
```

- `extract_pdf.py`는 PMBOK 6판 구조(장 = 지식 영역, `x.y.z` 절)의 교재에 맞춰져 있다. 예상 문제, 답과 해설, 부록(용어집), 목차는 제외한다. 구조가 다른 문서는 같은 JSONL 형식(`chunk_key, section, title, chapter_name, knowledge_area, text, hash`)만 맞추면 그대로 이어서 쓸 수 있다.
- 다시 적재하면 그 문서의 카드 집합 전체를 교체한다(파일에 없는 카드는 삭제). 서버는 10분 안에 새 카드를 읽는다(`KB_CACHE_TTL_MS`).
- 문서 하나를 끄려면 `UPDATE kb_documents SET active = false WHERE doc_key = '…'`를 실행한다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `KB_ENABLED` | `true` | `false`면 지식 검색 끔 |
| `KB_EMBEDDING_MODEL` | `text-embedding-3-small` | 적재·질문 양쪽이 같아야 벡터 검색(다르면 키워드) |
| `KB_TOP_K` | `5` | 질문당 카드 수 |
| `KB_MIN_SCORE` | `0.38` | 벡터 모드 하한(코사인 + 0.25×키워드) |
| `KB_MIN_KEYWORD_SCORE` | `0.4` | 키워드 모드 하한 |
| `KB_MAX_CHARS` | `4500` | 질문당 지식 텍스트 상한 |
| `KB_CARD_MODEL` | `gpt-4o-mini` | 카드 생성 모델(오프라인) |
| `KB_MAX_SHARED_RUN` | `8` | 카드·원문 연속 일치 어절 상한 |

AI_PROVIDER가 anthropic이어도 임베딩은 `OPENAI_API_KEY`로 동작한다. 키가 없으면 키워드 검색만 한다.

## 비용

- 질문 1건: 임베딩 약 US$0.000001(사용률 계산에서 제외할 만큼 작음) + 입력 프롬프트 약 2~3천 토큰 증가(gpt-4o-mini 기준 약 US$0.0004, 기존 ai_runs 정산에 포함).
- 920쪽 교재 1권: 카드 생성 약 US$0.3, 임베딩 US$0.01 미만(1회).

## 평가

`scripts/kb/golden-pmbok6.json`(35문항, 실무형 질문 → 기대 절)으로 카드를 다시 만들거나, 모델·임계값을 바꿀 때마다 `eval.mjs`를 돌린다. MISS 목록을 보고 카드 키워드나 임계값을 조정한다.
