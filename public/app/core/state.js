
export const state = { user: null, workspace: null, workspaces: [] };

/** 단건결제 모드 (server ONE_TIME_PAYMENT_MODE, /api/me features): Pro / Team = 1개월 이용권, AI credits for every plan, no 정기결제 screens. */
export const oneTimeMode = () => Boolean(state.features && state.features.one_time_payment);
