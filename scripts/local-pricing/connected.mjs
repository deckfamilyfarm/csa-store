import dotenv from 'dotenv';
// Explicit opt-in: use the same database and integration credentials as production.
// The normal `npm run dev` continues to use the isolated Docker database.
dotenv.config({ path: new URL('../../.env', import.meta.url), override: true });
Object.assign(process.env, {
  CSA_LOCAL_ONLY: 'false', NODE_ENV: 'development', PORT: '5181', API_BIND_HOST: '127.0.0.1',
  STORE_SERVE_FRONTEND: 'false', AUTO_SEED_ADMIN: 'false', AUTO_SEED_USER: 'false',
  LOCALLINE_DASHBOARD_ENV_PATH: '/dev/null'
});
console.log('Connected development: http://127.0.0.1:5180/admin');
console.log('Using the server database from .env. Saved edits affect production; channel publication requires approval.');
await import('../../apps/api/index.js');
