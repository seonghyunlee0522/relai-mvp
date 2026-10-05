/**
 * Project Chater — the project's reference information, assembled from 프로젝트 정의 (+ project basics).
 *
 * Nothing is stored here: the single source of truth is project_definitions / projects / wbs_items. This module only
 * reshapes it, once, for two readers:
 *   - the read-only Project Chater screen          GET …/:pid/charter → { charter, today }
 *   - every AI request that needs project context  charterPromptBlock() → "[PROJECT CHATER] …" (ai/context.js projectBlock)
 * So what the screen says "AI 가 참고합니다" is exactly what the AI receives.
 */
import { loadDefinition, ORG_TYPE_LABEL } from './definition.js';

const OPS_LABEL = { meetings: '회의', reporting: '보고', communication: '소통 채널' };
const texts = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.text || '')).filter(Boolean) : []);
const dateStr = (v) => (!v ? null : typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));

/**
 * Common Project Context (shape agreed in the Project Chater spec §27). Free-text fields stay free text.
 * `definition` may be passed when the caller already loaded it (avoids a second read).
 */
export async function buildProjectCharter(db, project, { definition = null } = {}) {
  const model = definition || (await loadDefinition(db, project));
  const d = model.definition;
  const ws = await db.get('SELECT name FROM workspaces WHERE id = ?', [project.workspace_id]);
  const own = [...new Set((d.stakeholders || []).filter((s) => s.org_type === 'OWN' && s.org).map((s) => s.org))];
  const ops = d.operations || {};
  const communication = Object.entries(OPS_LABEL).filter(([k]) => ops[k]).map(([k, label]) => `${label}: ${ops[k]}`).join('\n');
  const milestones = [
    ...(d.key_dates || []).filter((k) => k.title).map((k) => ({ id: k.id, title: k.title, date: k.date || null, source: 'KEY_DATE' })),
    ...(model.wbs_milestones || []).map((w) => ({ id: w.id, title: w.title, date: dateStr(w.milestone_date), source: 'WBS', wbs_code: w.wbs_code, status: w.status })),
  ].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  return {
    profile: {
      name: project.name, description: project.description || '', client: project.client_name || '',
      performer: own.join(', ') || (ws ? ws.name : ''), performer_source: own.length ? 'STAKEHOLDERS' : 'WORKSPACE',
      start_date: dateStr(project.planned_start_date), end_date: dateStr(project.planned_end_date), project_type: d.project_type || '',
    },
    goals: d.goal || '',
    successCriteria: texts(d.success_criteria).join('\n'),
    scope: { inScope: texts(d.scope_in).join('\n'), outOfScope: texts(d.scope_out).join('\n') },
    deliverables: d.deliverables || '',
    stakeholders: (d.stakeholders || []).map((s) => ({ name: s.name, org: s.org || '', department: s.department || '', category: s.org_type || 'OTHER', category_label: ORG_TYPE_LABEL[s.org_type] || '기타', role: s.role || '', responsibility: s.area || '' })),
    governance: ops.decisions || '',
    timeline: { startDate: dateStr(project.planned_start_date), endDate: dateStr(project.planned_end_date), milestones },
    assumptions: d.assumptions || '',
    constraints: d.constraints || '',
    risks: d.initial_risks || '',
    operatingModel: { communication, changeManagement: d.change_management || '', acceptance: d.acceptance || '' },
  };
}

/* ---------- AI prompt block ---------- */
const NONE = '(작성되지 않음)';
const v = (s, clip) => { const t = clip(s); return t || NONE; };

/**
 * "[PROJECT CHATER] …" — the project's reference information for every AI request, labelled section by section (spec §29).
 * `clip(text, max)` is the caller's neutralizing clipper (prompt-injection safe, length capped).
 */
export function charterPromptBlock(c, clip) {
  const ml = (s, n = 1200) => clip(String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' / '), n);
  const p = c.profile;
  const sh = c.stakeholders.slice(0, 30).map((s) => `- ${clip(s.name, 40)} | ${clip([s.org, s.department].filter(Boolean).join(' '), 60) || '-'} | ${s.category_label} | ${clip(s.role, 60) || '-'}${s.responsibility ? ` | ${clip(s.responsibility, 120)}` : ''}`).join('\n');
  const ms = c.timeline.milestones.slice(0, 30).map((m) => `- ${m.date || '날짜 미정'} ${clip(m.title, 100)}${m.source === 'WBS' ? ` (WBS ${m.wbs_code})` : ''}`).join('\n');
  return `[PROJECT CHATER]
아래는 이 프로젝트의 공식 기준정보(Project Chater)입니다. 일반 참고자료가 아니라 요구사항 검토·WBS 구성·변경 영향 판단·다음 작업 제안의 기준으로 사용하세요. "${NONE}" 항목은 아직 정의되지 않은 것이므로 추정해서 채우지 마세요.

Project Profile:
프로젝트명: ${v(p.name, (x) => clip(x, 100))}
설명/배경: ${v(p.description, (x) => ml(x, 800))}
고객사: ${v(p.client, (x) => clip(x, 100))}
수행사: ${v(p.performer, (x) => clip(x, 100))}
유형: ${v(p.project_type, (x) => clip(x, 100))}
기간: ${p.start_date || '?'} ~ ${p.end_date || '?'}

Goals:
${v(c.goals, (x) => ml(x, 1000))}

Success Criteria:
${v(c.successCriteria, (x) => ml(x))}

In Scope:
${v(c.scope.inScope, (x) => ml(x, 1600))}

Out of Scope:
${v(c.scope.outOfScope, (x) => ml(x))}

Deliverables:
${v(c.deliverables, (x) => ml(x))}

Stakeholders:
${sh || NONE}

Governance:
${v(c.governance, (x) => ml(x, 800))}

Timeline:
기간: ${c.timeline.startDate || '?'} ~ ${c.timeline.endDate || '?'}
${ms || `주요 마일스톤: ${NONE}`}

Assumptions:
${v(c.assumptions, (x) => ml(x))}

Constraints:
${v(c.constraints, (x) => ml(x))}

Risks:
${v(c.risks, (x) => ml(x))}

Operating Model:
Communication: ${v(c.operatingModel.communication, (x) => ml(x, 800))}
Change Management: ${v(c.operatingModel.changeManagement, (x) => ml(x, 800))}
Acceptance / Completion: ${v(c.operatingModel.acceptance, (x) => ml(x, 800))}`;
}
