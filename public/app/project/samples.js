/* 샘플 프로젝트 (server/samples/): badge, 모두 삭제 / 추가, and one sample's delete. Samples are example data — never counted as usage. */
import { api } from '../core/api.js';
import { html } from '../core/dom.js';
import { state } from '../core/state.js';
import { confirmDialog, toast } from '../shared/dialogs.js';

export const isSample = (p) => Boolean(p && p.sample_key);
export const sampleChip = (p) => (isSample(p) ? html`<span class="chip chip--sample" data-sample-badge title="RELAI 사용 예시로 넣어 둔 샘플 프로젝트입니다. 사용량에 포함되지 않습니다.">샘플</span>` : '');
const wsUrl = (path = '') => `/api/workspaces/${state.workspace.id}${path}`;

/** Deletes every sample of the workspace after a confirm. Resolves true when deleted. */
export async function deleteAllSamples() {
  if (!(await confirmDialog({ title: '샘플 프로젝트를 삭제할까요?', body: '샘플 프로젝트와 그 안의 예시 데이터가 모두 삭제됩니다. 직접 만든 프로젝트는 그대로 남습니다. 설정에서 언제든 다시 추가할 수 있습니다.', confirm: '샘플 프로젝트 삭제', danger: true }))) return false;
  try { const r = await api('DELETE', wsUrl('/samples')); toast(`샘플 프로젝트 ${r.deleted}개를 삭제했습니다.`); return true; } catch (e) { toast(e.message); return false; }
}
/** Deletes one sample project after a confirm. */
export async function deleteSample(pid, name) {
  if (!(await confirmDialog({ title: `'${name}' 샘플을 삭제할까요?`, body: '이 샘플 프로젝트와 예시 데이터가 삭제됩니다. 설정에서 다시 추가할 수 있습니다.', confirm: '샘플 삭제', danger: true }))) return false;
  try { await api('DELETE', wsUrl(`/projects/${pid}`)); toast('샘플 프로젝트를 삭제했습니다.'); return true; } catch (e) { toast(e.message); return false; }
}
/** Adds the missing samples (설정 · demo accounts). */
export async function addSamples() {
  try { const r = await api('POST', wsUrl('/samples'), {}); toast(`샘플 프로젝트 ${r.projects.length}개를 추가했습니다.`); return true; } catch (e) { toast(e.message); return false; }
}
