/**
 * JSON schemas for every AI feature + a small validator. The schemas are written in the subset both vendors accept
 * natively (OpenAI strict mode: every property required, additionalProperties:false, nullable = ["T","null"]).
 * Validation runs server-side on every AI response regardless of vendor — the frontend never sees unvalidated output.
 */
import { REQ_TYPES, REQ_PRIORITIES, REQ_SCOPES } from '../requirements.js';
import { WBS_TYPES } from '../wbs.js';
import { IMPACT_TYPES } from '../changes.js';

export const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
export const REF_TYPES = ['REQUIREMENT', 'WBS', 'CHANGE', 'ISSUE', 'RISK', 'TEST', 'ACCEPTANCE'];

const str = (maxLength) => ({ type: 'string', ...(maxLength ? { maxLength } : {}) });
const nstr = (maxLength) => ({ type: ['string', 'null'], ...(maxLength ? { maxLength } : {}) });
const en = (values) => ({ type: 'string', enum: values });
const arr = (items, maxItems) => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/* ---------- Phase 15: AI Project WBS Planner ---------- */
export const PLAN_AREAS = ['PROJECT_MANAGEMENT', 'ANALYSIS_DESIGN', 'FUNCTIONAL_DEVELOPMENT', 'NON_FUNCTIONAL', 'INTERFACE', 'DATA_MIGRATION', 'INFRASTRUCTURE', 'SECURITY', 'ENVIRONMENT', 'TESTING', 'UAT', 'DEPLOYMENT', 'CUTOVER', 'TRAINING', 'DOCUMENTATION', 'OPERATION_HANDOVER', 'STABILIZATION', 'OTHER'];
export const AREA_STATUS = ['REQUIRED', 'POSSIBLE', 'NOT_NEEDED', 'UNKNOWN'];
export const AREA_SOURCE = ['REQUIREMENT', 'PROJECT_DEFINITION', 'PROJECT_TYPE', 'USER_ANSWER', 'INFERRED'];
export const QUESTION_TYPES = ['SINGLE', 'MULTI', 'TEXT', 'BOOLEAN'];
export const PLAN_ITEM_TYPES = ['TASK', 'MILESTONE'];
const planItem = () => obj({
  temp_id: str(20), parent_temp_id: nstr(20), item_type: en(PLAN_ITEM_TYPES), title: str(200), description: str(2000), project_area: str(40),   // validated server-side (unknown → OTHER)
  planned_duration_days: { type: ['integer', 'null'], minimum: 0, maximum: 365 }, related_requirement_ids: arr(str(20), 20),
});
export const PLANNER_SCHEMAS = {
  wbs_planning_questions: obj({
    areas: arr(obj({ area: str(40), status: en(AREA_STATUS), source: en(AREA_SOURCE), reason: str(300) }), 30),
    questions: arr(obj({
      id: str(40), area: str(40), question: str(200), help_text: nstr(300), type: en(QUESTION_TYPES), required: { type: 'boolean' },
      options: arr(obj({ id: str(40), label: str(80), followups: arr(obj({ id: str(40), label: str(80) }), 12) }), 12), allow_other: { type: 'boolean' }, reason: str(300),
    }), 20),
  }),
  project_wbs_draft: obj({ items: arr(planItem(), 100), notes: arr(str(300), 8) }),
  wbs_plan_fix: obj({ items: arr(planItem(), 30), notes: arr(str(300), 5) }),
};

export const SCHEMAS = {
  REQUIREMENT_EXTRACTION: obj({
    candidates: arr(obj({
      title: str(200), description: str(5000), type: en(REQ_TYPES), priority: en(REQ_PRIORITIES), scope: en(REQ_SCOPES),
      requester_name: nstr(100), requester_organization: nstr(100), acceptance_criteria: arr(str(1000), 10),
      source_text: str(1000), confidence: en(CONFIDENCE), similar_to: nstr(20),
    }), 40),
  }),
  WBS_GENERATION: obj({
    items: arr(obj({
      temp_id: str(20), parent_temp_id: nstr(20), item_type: en(WBS_TYPES), title: str(200), description: str(2000),
      planned_duration_days: { type: ['integer', 'null'], minimum: 0, maximum: 365 }, related_requirement_ids: arr(str(20), 20),
    }), 80),
    notes: arr(str(300), 5),
  }),
  CHANGE_IMPACT: obj({
    summary: str(1000),
    affected_requirements: arr(obj({ display_id: str(20), reason: str(500), confidence: en(CONFIDENCE) }), 40),
    affected_wbs: arr(obj({ wbs_code: str(30), impact_type: en(IMPACT_TYPES), reason: str(500), confidence: en(CONFIDENCE) }), 60),
    affected_tests: arr(obj({ display_id: str(20), reason: str(500), confidence: en(CONFIDENCE) }), 40),
    possible_risks: arr(obj({ display_id: str(20), reason: str(500), confidence: en(CONFIDENCE) }), 20),
  }),
  PROJECT_QA: obj({
    answer: str(4000),
    references: arr(obj({ type: en(REF_TYPES), display_id: str(30) }), 20),
    warnings: arr(str(300), 5),
  }),
  WBS_PLAN_QUESTIONS: PLANNER_SCHEMAS.wbs_planning_questions,
  WBS_PLAN_FIX: PLANNER_SCHEMAS.wbs_plan_fix,
};

/** Minimal JSON-schema validator for the subset above. Returns [] when valid, else ["path: problem", …] (capped). */
export function validateSchema(schema, value, path = '$', errors = []) {
  if (errors.length >= 20) return errors;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const typeOk = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
  if (!typeOk) { errors.push(`${path}: expected ${types.join('|')}, got ${actual}`); return errors; }
  if (value === null) return errors;
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (actual === 'string') { if (schema.maxLength && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`); }
  if (actual === 'integer' || actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (actual === 'array') {
    if (schema.maxItems && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.minItems && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => validateSchema(schema.items, v, `${path}[${i}]`, errors));
  }
  if (actual === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: missing`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) { if (schema.additionalProperties === false) errors.push(`${path}.${k}: unexpected property`); continue; }
      validateSchema(sub, v, `${path}.${k}`, errors);
    }
  }
  return errors;
}

/** Trims string leaves in place (models love trailing spaces) — run before validation so maxLength is judged on trimmed text. */
export function trimDeep(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(trimDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimDeep(x)]));
  return v;
}
