// Picks the back end. config.js sets window.DIARY_CONFIG: { api: '/api' } on the server,
// {} in the demo (sample data in the browser). The demo code loads only in the demo.
const cfg = window.DIARY_CONFIG || {};

export const api = cfg.api
  ? new (await import('./http.js')).HttpApi(cfg.api)
  : new (await import('./mock.js')).MockApi();
