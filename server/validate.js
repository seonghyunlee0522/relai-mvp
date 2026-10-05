import { PROJECT_TRAITS } from '../public/app/shared/project-traits.js';
export const STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'];
export const PHASES = ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS'];

export class ValidationError extends Error {
  constructor(fields) {
    super('validation');
    this.fields = fields;
  }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
  && new Date(s).toISOString().slice(0, 10) === s;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function parseSignup(b = {}) {
  const f = {};
  const name = str(b.name);
  const email = str(b.email).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  if (!name || name.length > 50) f.name = '이름을 50자 이내로 입력해 주세요.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) f.email = '올바른 이메일 주소를 입력해 주세요.';
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    f.password = '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.';
  if (Object.keys(f).length) throw new ValidationError(f);
  return { name, email, password };
}

/** Used for create (partial=false) and update (partial=false too: edit form always sends full basic info). */
/**
 * Project basics + 프로젝트 기본 특성. `requireType` is set on create only: projects made before project_type existed keep NULL
 * ("미설정") through later edits until someone sets it. Unknown option values are refused; missing traits default to TBD.
 */
/** Validate 프로젝트 기본 특성 against the shared option set. `partial` = only the keys present in `b` (definition save). Errors go into `f`. */
export function parseTraits(b = {}, f = {}, { requireType = false, partial = false } = {}) {
  const out = {};
  for (const t of PROJECT_TRAITS) {
    const has = b[t.field] !== undefined;
    if (partial && !has) continue;
    const raw = b[t.field] === null || b[t.field] === undefined ? '' : String(b[t.field]).trim();
    if (!raw) {
      if (t.required && requireType) f[t.field] = '프로젝트 유형을 선택해 주세요.';
      else out[t.field] = t.required ? null : t.default;
      continue;
    }
    if (!t.options.some((o) => o.value === raw)) { f[t.field] = `${t.label} 값이 올바르지 않습니다.`; continue; }
    out[t.field] = raw;
  }
  return out;
}

export function parseProject(b = {}, { requireType = false } = {}) {
  const f = {};
  const name = str(b.name);
  const description = str(b.description);
  const client_name = str(b.client_name);
  const project_scale = str(b.project_scale);
  const planned_start_date = b.planned_start_date;
  const planned_end_date = b.planned_end_date;
  if (!name || name.length > 100) f.name = '프로젝트 이름을 100자 이내로 입력해 주세요.';
  if (!client_name || client_name.length > 100) f.client_name = '고객사명을 100자 이내로 입력해 주세요.';
  if (project_scale.length > 200) f.project_scale = '프로젝트 규모 / 금액은 200자 이내로 입력해 주세요.';
  if (!isDate(planned_start_date)) f.planned_start_date = '예상 시작일을 입력해 주세요.';
  if (!isDate(planned_end_date)) f.planned_end_date = '예상 종료일을 입력해 주세요.';
  if (!f.planned_start_date && !f.planned_end_date && planned_end_date < planned_start_date)
    f.planned_end_date = '종료일은 시작일 이후여야 합니다.';
  if (description.length > 2000) f.description = '설명은 2,000자 이내로 입력해 주세요.';
  const traits = parseTraits(b, f, { requireType });
  if (Object.keys(f).length) throw new ValidationError(f);
  return { name, description, client_name, project_scale, planned_start_date, planned_end_date, ...traits };
}
