/**
 * Excel template / import specification shared by xlsx.js (file I/O) and importer.js (validation + creation).
 * Column keys are part of the frontend contract — do not rename.
 */
import { REQ_TYPES, REQ_PRIORITIES, REQ_SCOPES, REQ_STATUSES } from './requirements.js';
import { WBS_STATUSES } from './wbs.js';

const opts = (codes, labels) => codes.map((value) => ({ value, label: labels[value] }));

export const LABELS = {
  type: { UNSPECIFIED: '미지정', FUNCTIONAL: '기능', NON_FUNCTIONAL: '비기능', INTERFACE: '인터페이스', DATA: '데이터', SECURITY: '보안', OPERATION: '운영', OTHER: '기타' },
  priority: { UNSPECIFIED: '미지정', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' },
  scope: { UNDECIDED: '미결정', IN_SCOPE: '범위 내', OUT_OF_SCOPE: '범위 외' },
  status: { DRAFT: '작성 중', REVIEWING: '검토 중', CONFIRMED: '확정', ON_HOLD: '보류', REJECTED: '반려' },
  item_type: { SUMMARY: '상위 항목', TASK: '작업', MILESTONE: '마일스톤' },
  wbs_status: { NOT_STARTED: '시작 전', IN_PROGRESS: '진행 중', COMPLETED: '완료', ON_HOLD: '보류' },
};

export const KINDS = {
  requirements: {
    key: 'requirements',
    sheet: '요구사항',
    names: { template: '요구사항 등록 템플릿', export: '요구사항', ascii: 'requirements' },
    requiredHeaders: ['title'],
    columns: [
      { key: 'display_id', label: '요구사항 ID', required: false, type: 'text', width: 14,
        hint: '비워 두면 자동 채번합니다. 직접 입력 시 REQ-001 형식이며 프로젝트 내에 이미 있는 ID는 사용할 수 없습니다.', examples: ['REQ-010', '(비움)'] },
      { key: 'title', label: '요구사항명', required: true, type: 'text', width: 34, hint: '200자 이내', examples: ['SSO 로그인 지원', '계약서 업로드 시 자동 분류'] },
      { key: 'description', label: '요구사항 설명', required: false, type: 'multiline', width: 50, hint: '5,000자 이내. 셀 안에서 줄바꿈(Alt+Enter) 가능', examples: ['사내 Entra ID 계정으로 로그인한다.'] },
      { key: 'type', label: '분류', required: false, type: 'enum', width: 13, options: opts(REQ_TYPES, LABELS.type), hint: '목록에서 선택 (영문 코드도 허용). 비우면 미지정', examples: ['기능', '비기능', '보안'] },
      { key: 'priority', label: '우선순위', required: false, type: 'enum', width: 12, options: opts(REQ_PRIORITIES, LABELS.priority), hint: '목록에서 선택. 비우면 미지정', examples: ['High', 'Medium', 'Low'] },
      { key: 'scope', label: '범위', required: false, type: 'enum', width: 12, options: opts(REQ_SCOPES, LABELS.scope), hint: '목록에서 선택. 비우면 미결정', examples: ['범위 내', '범위 외'] },
      { key: 'status', label: '상태', required: false, type: 'enum', width: 12, options: opts(REQ_STATUSES, LABELS.status), hint: '목록에서 선택. 비우면 작성 중', examples: ['작성 중', '검토 중', '확정'] },
      { key: 'owner', label: '담당자', required: false, type: 'owner', width: 20, hint: 'Workspace 멤버의 이메일 또는 이름(정확히 일치). 이름이 중복되면 이메일로 입력', examples: ['hong@company.com', '홍길동'] },
      { key: 'requester_name', label: '요청자', required: false, type: 'text', width: 14, hint: '100자 이내', examples: ['김OO 책임'] },
      { key: 'requester_organization', label: '요청자 소속', required: false, type: 'text', width: 18, hint: '100자 이내', examples: ['A사 IT팀'] },
      { key: 'criteria', label: '완료 조건', required: false, type: 'multiline', width: 50, hint: '한 줄에 하나씩(Alt+Enter로 줄바꿈), 줄마다 1,000자 이내', examples: ['SSO 로그인 성공 시 메인 화면으로 이동한다.\n미등록 계정은 오류 안내를 표시한다.'] },
    ],
  },
  wbs: {
    key: 'wbs',
    sheet: 'WBS',
    names: { template: 'WBS 등록 템플릿', export: 'WBS', ascii: 'wbs' },
    requiredHeaders: ['code', 'title'],
    columns: [
      { key: 'code', label: 'WBS Code', required: true, type: 'text', width: 12, hint: '계층 번호: 1, 1.1, 1.2.1 … 파일 안에서만 쓰는 참조값이며 실제 번호는 행 순서대로 다시 부여됩니다.', examples: ['1', '1.1', '1.2.1'] },
      { key: 'parent_code', label: '상위 WBS', required: false, type: 'text', width: 12, hint: '비워 두면 WBS Code에서 자동 계산. 입력 시 WBS Code에서 마지막 단계를 뺀 값이어야 합니다.', examples: ['(1.1의 상위) 1', '(최상위) 비움'] },
      { key: 'item_type', label: '유형', required: false, type: 'enum', width: 12, options: opts(['SUMMARY', 'TASK', 'MILESTONE'], LABELS.item_type), hint: '상위 항목 / 작업 / 마일스톤. 비우면 하위 항목이 있으면 상위 항목, 없으면 작업', examples: ['상위 항목', '작업', '마일스톤'] },
      { key: 'title', label: '업무명', required: true, type: 'text', width: 34, hint: '200자 이내', examples: ['요구사항 분석', '화면 설계'] },
      { key: 'description', label: '업무 설명', required: false, type: 'multiline', width: 44, hint: '5,000자 이내', examples: ['고객 인터뷰 및 요구사항 정리'] },
      { key: 'owner', label: '담당자', required: false, type: 'owner', width: 20, hint: 'Workspace 멤버의 이메일 또는 이름(정확히 일치)', examples: ['hong@company.com', '홍길동'] },
      { key: 'start', label: '시작일', required: false, type: 'date', width: 13, hint: 'YYYY-MM-DD (YYYY.MM.DD, YYYY/MM/DD, 엑셀 날짜도 허용). 마일스톤은 비워 둡니다.', examples: ['2026-11-02'] },
      { key: 'end', label: '종료일', required: false, type: 'date', width: 13, hint: '시작일 이후여야 합니다. 마일스톤은 이 칸에 마일스톤 날짜를 입력합니다.', examples: ['2026-11-13'] },
      { key: 'status', label: '상태', required: false, type: 'enum', width: 12, options: opts(WBS_STATUSES, LABELS.wbs_status), hint: '시작 전 / 진행 중 / 완료 / 보류. 비우면 시작 전', examples: ['시작 전', '진행 중'] },
      { key: 'progress', label: '진행률', required: false, type: 'number', width: 10, hint: '0~100 정수, 작업에만 입력', examples: ['0', '50', '100'] },
      { key: 'predecessors', label: '선행 작업', required: false, type: 'text', width: 18, hint: '같은 파일의 WBS Code를 쉼표로 구분 (종료 후 시작 관계)', examples: ['1.1', '1.1, 1.2'] },
    ],
  },
};

export const publicColumns = (kind) => KINDS[kind].columns.map(({ key, label, required, type, options }) => ({ key, label, required, type, ...(options ? { options } : {}) }));
export const normHeader = (s) => String(s ?? '').replace(/\s+/g, '').replace(/\*+$/, '').toLowerCase();
