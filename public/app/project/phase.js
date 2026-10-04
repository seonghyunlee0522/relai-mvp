/* Legacy route /app/projects/:id/phases/:key — the intermediate phase screen was removed in Lifecycle V2.
 * Old deep links land on What’s Next, which shows the current phase's activities inline. */
import { navigate } from '../core/router.js';
export async function phasePage(id) { navigate(`/app/projects/${id}`, { replace: true }); }
