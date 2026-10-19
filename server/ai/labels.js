/**
 * Internal enum codes → the Korean labels the UI shows. The AI context lists rows as "REQ-001 [DRAFT/UNDECIDED/HIGH] …"
 * and the model sometimes copies those codes into its answer; humanizeCodes() turns them back into what the PM sees on
 * screen ("[작성 중/미결정/높음]"). Only whole tokens that are known codes are replaced, so IDs (REQ-001, CR-002) and
 * ordinary English words stay as they are. Labels come from the UI constants, so screen and answer never disagree.
 */
import * as K from '../../public/app/shared/constants.js';

// First map wins on a shared code (DRAFT is 작성 중 for requirements/CRs/tests; the project-level 초안 never reaches the AI context).
const MAPS = [K.REQ_STATUS, K.REQ_SCOPE, K.REQ_PRIORITY, K.REQ_TYPE, K.CR_STATUS, K.RELATION_TYPE, K.IMPACT_TYPE, K.WBS_TYPE, K.WBS_STATUS,
  K.ISSUE_STATUS, K.SEVERITY, K.RISK_STATUS, K.RISK_LEVEL, K.TC_STATUS, K.RESULT, K.ACC_STATUS];
export const CODE_LABEL = {};
for (const m of MAPS) for (const [code, label] of Object.entries(m)) if (!(code in CODE_LABEL)) CODE_LABEL[code] = label;

const TOKEN = /(?<![A-Za-z0-9_-])[A-Z][A-Z_]{2,}(?![A-Za-z0-9_-])/g;
export function humanizeCodes(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(TOKEN, (t) => CODE_LABEL[t] ?? t);
}
