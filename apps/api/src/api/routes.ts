import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Elysia } from 'elysia';
import {
  createDeployment,
  getDeploymentById,
  getLogs,
  listDeployments
} from '../db/repo';
import { orchestrator } from '../orchestrator';
import { logBus } from '../orchestrator/log-bus';
import { config } from '../utils/config';

export const apiRoutes = new Elysia({ prefix: '/api' })
  .get('/health', () => ({ ok: true }))
  .get('/deployments', async () => {
    return listDeployments();
  })
  .get('/deployments/:id', async ({ params, set }) => {
    const deployment = await getDeploymentById(params.id);
    if (!deployment) {
      set.status = 404;
      return { error: 'Deployment not found' };
    }
    return deployment;
  })
  .post('/deployments', async ({ request, set }) => {
    const contentType = request.headers.get('content-type') ?? '';

    if (!contentType.includes('multipart/form-data')) {
      set.status = 400;
      return { error: 'Expected multipart/form-data payload' };
    }

    const form = await request.formData();
    const sourceType = String(form.get('sourceType') ?? '');
    const projectId = String(form.get('projectId') ?? '').trim() || undefined;

    if (sourceType !== 'git' && sourceType !== 'upload') {
      set.status = 400;
      return { error: 'sourceType must be git or upload' };
    }

    if (sourceType === 'git') {
      const gitUrl = String(form.get('gitUrl') ?? '').trim();
      if (!gitUrl) {
        set.status = 400;
        return { error: 'gitUrl is required for git source' };
      }

      const deployment = await createDeployment({
        projectId,
        sourceType: 'git',
        sourceRef: gitUrl
      });

      orchestrator.enqueue(deployment.id);
      return deployment;
    }

    const file = form.get('archive');
    if (!(file instanceof File)) {
      set.status = 400;
      return { error: 'archive file is required for upload source' };
    }

    const uploadsDir = join(config.workspaceRoot, 'uploads');
    await mkdir(uploadsDir, { recursive: true });

    const safeName = basename(file.name || 'project.zip').replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadPath = join(uploadsDir, `${Date.now()}-${safeName}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await writeFile(uploadPath, bytes);

    const deployment = await createDeployment({
      projectId,
      sourceType: 'upload',
      sourceRef: uploadPath
    });

    orchestrator.enqueue(deployment.id);
    return deployment;
  })
  .post('/deployments/:id/rollback', async ({ params, set }) => {
    const original = await getDeploymentById(params.id);
    if (!original) {
      set.status = 404;
      return { error: 'Deployment not found' };
    }

    if (!original.imageTag) {
      set.status = 400;
      return { error: 'Deployment has no built image to rollback to' };
    }

    const deployment = await createDeployment({
      projectId: original.projectId || undefined,
      sourceType: 'image',
      sourceRef: original.imageTag
    });

    orchestrator.enqueue(deployment.id);
    return deployment;
  })
  .get('/deployments/:id/logs', async ({ params, set }) => {
    const deployment = await getDeploymentById(params.id);
    if (!deployment) {
      set.status = 404;
      return { error: 'Deployment not found' };
    }
    return getLogs(params.id);
  })
  .get('/deployments/:id/logs/stream', async ({ params, request, set }) => {
    const deployment = await getDeploymentById(params.id);
    if (!deployment) {
      set.status = 404;
      return { error: 'Deployment not found' };
    }

    const encoder = new TextEncoder();
    let unsubscribe = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    let closed = false;
    const stop = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (eventName: string, payload: unknown) => {
          if (closed) {
            return;
          }
          controller.enqueue(
            encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
          );
        };

        send('ready', { deploymentId: params.id });

        unsubscribe = logBus.subscribe(params.id, (event) => {
          send('log', event);
        });

        heartbeat = setInterval(() => {
          send('heartbeat', { at: new Date().toISOString() });
        }, 15000);
      },
      cancel() {
        stop();
      }
    });

    const abortSignal = request.signal;
    abortSignal.addEventListener('abort', stop, { once: true });

    set.headers['content-type'] = 'text/event-stream';
    set.headers['cache-control'] = 'no-cache';
    set.headers.connection = 'keep-alive';

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      }
    });
  });
