
export const state = { user: null, workspace: null, workspaces: [] };

/** NicePay 심사 모드 (server CREDITS_ONLY_MODE, /api/me features): AI credits are the only product — no plan / 구독 screens or copy. */
export const creditsOnly = () => Boolean(state.features && state.features.credits_only);
