/** Provider registry. The service asks here for a provider by name; tests swap in the fake. */
import { integrationConfig } from './config.js';
import { liveJiraProvider, fakeJiraProvider } from './jira/provider.js';

let override = null;
export function getProvider(name, env = process.env) {
  if (override && override.name === name) return override;
  const cfg = integrationConfig(env);
  if (name === 'JIRA') {
    if (cfg.provider === 'fake') { override = fakeJiraProvider(); return override; }
    return liveJiraProvider(cfg.jira);
  }
  throw new Error(`unknown provider ${name}`);
}
/** Tests: install a fake (or null to reset). */
export function setProvider(p) { override = p; }
