import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { apiRoutes } from './api/routes';
import { migrate } from './db/migrate';
import { config } from './utils/config';
import { dockerBin } from './utils/docker-bin';

const bootstrap = async () => {
  await mkdir(dirname(config.databasePath), { recursive: true });
  await mkdir(config.workspaceRoot, { recursive: true });
  await mkdir(config.caddyRoutesDir, { recursive: true });
  await migrate();

  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    const child = spawn(dockerBin, ['buildx', 'inspect', 'brim-builder']);
    let stderr = '';
    child.stderr.on('data', (c: any) => { stderr += String(c); });
    child.on('close', () => {
      if (stderr.includes('does not exist')) {
        const create = spawn(dockerBin, ['buildx', 'create', '--name', 'brim-builder', '--driver', 'docker-container']);
        create.on('close', () => {
          const use = spawn(dockerBin, ['buildx', 'use', 'brim-builder']);
          use.on('close', resolve);
          use.on('error', resolve);
        });
        create.on('error', resolve);
      } else {
        resolve();
      }
    });
    child.on('error', resolve);
  });

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
