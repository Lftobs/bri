import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { apiRoutes } from './api/routes';
import { migrate } from './db/migrate';
import { orchestrator } from './orchestrator';
import { config } from './utils/config';

const bootstrap = async () => {
  await mkdir(dirname(config.databasePath), { recursive: true });
  await mkdir(config.workspaceRoot, { recursive: true });
  await mkdir(config.caddyRoutesDir, { recursive: true });

  await migrate();
  await orchestrator.reconcileState();

  const app = new Elysia()
    .use(cors())
    .use(apiRoutes)
    .get('/', () => ({ service: 'brim-api', ok: true }));

  app.listen(config.port);
  console.log(`API listening on :${config.port}`);
};

bootstrap().catch((error) => {
  console.error('Bootstrap failed', error);
  process.exit(1);
});
