/* 프로젝트 기본 특성 (Project traits) — the ONE option set for every screen and for server validation.
 *
 *   Frontend   project/form.js (생성 · 정보 수정), project/definition.js (착수 › 프로젝트 정의), project/charter.js (조회)
 *   Backend    server/validate.js imports this file directly (pure data, no DOM), so a value the UI cannot offer can never be stored.
 *
 * Stored on projects (columns = `field`). project_type is required on create and may be NULL on projects created before it
 * existed (shown "미설정"); every other trait defaults to TBD ("미정") — never to NO, because "모름" and "해당 없음" differ.
 * No AI use in this phase. */

export const PROJECT_TYPES = [
  { value: 'NEW_BUILD', label: '신규 구축', help: '새로운 시스템이나 서비스를 처음 구축하는 프로젝트' },
  { value: 'ENHANCEMENT', label: '고도화', help: '기존 시스템에 새로운 기능을 추가하거나 구조를 개선하는 프로젝트' },
  { value: 'TRANSITION', label: '전환 / 교체', help: '현재 사용 중인 시스템을 새로운 시스템이나 환경으로 대체하는 프로젝트' },
  { value: 'OTHER', label: '기타', help: '위 유형에 명확히 해당하지 않는 프로젝트' },
];
export const BOOLEAN_TBD_OPTIONS = [{ value: 'YES', label: '있음' }, { value: 'NO', label: '없음' }, { value: 'TBD', label: '미정' }];
export const DATA_MIGRATION_OPTIONS = BOOLEAN_TBD_OPTIONS;
export const DEPLOYMENT_ENVIRONMENTS = [{ value: 'CLOUD', label: 'Cloud' }, { value: 'ON_PREMISE', label: 'On-Premise' }, { value: 'HYBRID', label: 'Hybrid' }, { value: 'TBD', label: '미정' }];
export const DELIVERY_MODELS = [{ value: 'ONSITE', label: '상주' }, { value: 'REMOTE', label: '비상주' }, { value: 'HYBRID', label: '혼합' }, { value: 'TBD', label: '미정' }];

/** Field order = display order (2-column pairs on desktop: 유형·환경 / 이관·수행 방식 / 기존 시스템·외부 연계). */
export const PROJECT_TRAITS = [
  { field: 'project_type', label: '프로젝트 유형', en: 'Project Type', options: PROJECT_TYPES, required: true, empty: '미설정', placeholder: '프로젝트 유형을 선택해주세요', help: '프로젝트의 기본 수행 형태를 선택합니다.' },
  { field: 'deployment_environment', label: '구축 환경', en: 'Deployment', options: DEPLOYMENT_ENVIRONMENTS, default: 'TBD', help: '시스템이 운영될 주요 인프라 환경을 선택합니다.' },
  { field: 'data_migration', label: '데이터 이관', en: 'Data Migration', options: DATA_MIGRATION_OPTIONS, default: 'TBD', help: '기존 시스템의 데이터를 신규 또는 변경된 시스템으로 이전해야 하는지 선택합니다.' },
  { field: 'delivery_model', label: '수행 방식', en: 'Delivery Model', options: DELIVERY_MODELS, default: 'TBD', help: '프로젝트 수행 인력이 주로 어떤 방식으로 근무하는지 선택합니다.' },
  { field: 'has_existing_system', label: '기존 시스템', en: 'Existing System', options: BOOLEAN_TBD_OPTIONS, default: 'TBD', help: '현재 사용 중이거나 이번 프로젝트와 관련된 기존 시스템이 있는지 선택합니다.' },
  { field: 'has_external_integration', label: '외부 시스템 연계', en: 'External Integration', options: BOOLEAN_TBD_OPTIONS, default: 'TBD', help: '이번 프로젝트에서 다른 시스템 또는 외부 서비스와의 연계가 필요한지 선택합니다.' },
];
export const TRAIT_FIELDS = PROJECT_TRAITS.map((t) => t.field);
export const traitOf = (field) => PROJECT_TRAITS.find((t) => t.field === field);
/** Display label of a stored value ("미설정" / "미정" when empty). */
export const traitLabel = (field, value) => {
  const t = traitOf(field); const o = t && t.options.find((x) => x.value === value);
  return o ? o.label : t ? (t.empty || '미정') : '';
};
