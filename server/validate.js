export const PROJECT_TYPES = ['SI', 'AI_POC', 'SAAS_IMPLEMENTATION', 'MIGRATION', 'INTERNAL', 'OTHER'];
export const SITUATIONS = ['NOT_STARTED', 'JUST_STARTED', 'IN_PROGRESS', 'TROUBLED'];
export const STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'];
export const PHASES = ['INITIATION', 'REQUIREMENTS', 'SCHEDULE', 'EXECUTION', 'TESTING', 'ACCEPTANCE', 'LAUNCH'];

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
export function parseProject(b = {}) {
  const f = {};
  const name = str(b.name);
  const description = str(b.description);
  const project_type = b.project_type;
  const current_situation = b.current_situation;
  const planned_start_date = b.planned_start_date;
  const planned_end_date = b.planned_end_date;
  if (!name || name.length > 100) f.name = '프로젝트 이름을 100자 이내로 입력해 주세요.';
  if (!PROJECT_TYPES.includes(project_type)) f.project_type = '프로젝트 유형을 선택해 주세요.';
  if (!SITUATIONS.includes(current_situation)) f.current_situation = '현재 상황을 선택해 주세요.';
  if (!isDate(planned_start_date)) f.planned_start_date = '예상 시작일을 입력해 주세요.';
  if (!isDate(planned_end_date)) f.planned_end_date = '예상 종료일을 입력해 주세요.';
  if (!f.planned_start_date && !f.planned_end_date && planned_end_date < planned_start_date)
    f.planned_end_date = '종료일은 시작일 이후여야 합니다.';
  if (description.length > 2000) f.description = '설명은 2,000자 이내로 입력해 주세요.';
  if (Object.keys(f).length) throw new ValidationError(f);
  return { name, description, project_type, current_situation, planned_start_date, planned_end_date };
}
