import { rm } from 'node:fs/promises';
import { appendLog, getDeploymentById, listDeployments, updateDeploymentStatus } from '../db/repo';
import { logBus } from './log-bus';
import { buildWithRailpack } from './railpack';
import { prepareSourceWorkspace, prepareUploadWorkspace, cleanupWorkspace } from './source';
import { deployContainer, ensureContainerRunning, reloadCaddy } from './runtime';

const now = () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

const emitLog = async (
  deploymentId: string,
  stage: 'build' | 'deploy' | 'system',
  message: string
) => {
  const timestamp = now();
  const saved = await appendLog(deploymentId, stage, message);
  logBus.publish({
    deploymentId,
    sequence: saved.sequence,
    stage,
    message,
    timestamp
  });
};

export class PipelineOrchestrator {
  private queue: string[] = [];
  private running = false;

  enqueue(deploymentId: string) {
    this.queue.push(deploymentId);
    this.drain().catch((error) => {
      console.error('Queue drain failed', error);
    });
  }

  async reconcileState() {
    console.log('Reconciling deployment state...');
    const deployments = await listDeployments();
    const running = deployments.filter((d) => d.status === 'running');

    for (const deployment of running) {
      if (deployment.containerName) {
        console.log(`Ensuring container ${deployment.containerName} is running`);
        await ensureContainerRunning(deployment.containerName);
      }
    }

    try {
      await reloadCaddy();
      console.log('Caddy reloaded during reconciliation');
    } catch (error) {
      console.log('Caddy not ready for reload during reconciliation. It will pick up routes automatically when it boots.');
    }
  }

  private async drain() {
    if (this.running) {
      return;
    }

    this.running = true;
    while (this.queue.length > 0) {
      const deploymentId = this.queue.shift();
      if (!deploymentId) {
        continue;
      }
      await this.runDeployment(deploymentId);
    }
    this.running = false;
  }

  private async runDeployment(deploymentId: string) {
    const deployment = await getDeploymentById(deploymentId);
    if (!deployment) {
      return;
    }

    let workspacePath = '';
    let uploadedArchivePath: string | null = null;

    try {
      await emitLog(deploymentId, 'system', 'Deployment enqueued');

      const imageTag = deployment.sourceType === 'image'
        ? deployment.sourceRef
        : `brim-${deploymentId}:latest`;

      if (deployment.sourceType !== 'image') {
        await updateDeploymentStatus(deploymentId, 'building', { failureReason: null });
        if (deployment.sourceType === 'git') {
          await emitLog(deploymentId, 'build', `Cloning git repository: ${deployment.sourceRef}`);
          workspacePath = await prepareSourceWorkspace(deploymentId, deployment.sourceRef);
        } else {
          await emitLog(deploymentId, 'build', `Extracting archive: ${deployment.sourceRef}`);
          uploadedArchivePath = deployment.sourceRef;
          workspacePath = await prepareUploadWorkspace(deploymentId, deployment.sourceRef);
        }
        await emitLog(deploymentId, 'build', `Source prepared at: ${workspacePath}`);

        const cacheKey = deployment.projectId || deploymentId;
        await buildWithRailpack(workspacePath, imageTag, async (line) => {
          await emitLog(deploymentId, 'build', line);
        }, { cacheKey });
      } else {
        await emitLog(deploymentId, 'build', `Rolling back to existing image: ${imageTag}`);
      }

      await updateDeploymentStatus(deploymentId, 'deploying', { imageTag });
      await emitLog(deploymentId, 'deploy', 'Starting container deployment');

      let oldContainerName: string | undefined;
      if (deployment.projectId) {
        const all = await listDeployments();
        const prev = all.find(d =>
          d.projectId === deployment.projectId &&
          d.status === 'running' &&
          d.id !== deploymentId
        );
        if (prev?.containerName) {
          oldContainerName = prev.containerName;
          await emitLog(deploymentId, 'deploy', `Found existing deployment ${prev.id} (${oldContainerName}) for zero-downtime swap`);
        }
      }

      const runtime = await deployContainer(deploymentId, imageTag, async (line) => {
        await emitLog(deploymentId, 'deploy', line);
      }, {
        projectId: deployment.projectId || undefined,
        oldContainerName
      });

      await updateDeploymentStatus(deploymentId, 'running', {
        imageTag,
        containerName: runtime.containerName,
        liveUrl: runtime.liveUrl,
        failureReason: null
      });

      if (oldContainerName && deployment.projectId) {
        const all = await listDeployments();
        const prev = all.find(d => d.containerName === oldContainerName && d.id !== deploymentId);
        if (prev) {
          await updateDeploymentStatus(prev.id, 'inactive', { failureReason: 'Superseded by new deployment' });
          await emitLog(prev.id, 'system', `Deployment marked inactive (superseded by ${deploymentId})`);
        }
      }

      await emitLog(deploymentId, 'system', 'Deployment is running');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown deployment failure';
      console.error(`[Orchestrator] Deployment ${deploymentId} failed:`, error);

      await emitLog(deploymentId, 'system', `CRITICAL FAILURE: ${message}`);
      await updateDeploymentStatus(deploymentId, 'failed', {
        failureReason: message
      });
    } finally {
      if (workspacePath) {
        await cleanupWorkspace(workspacePath);
      }
      if (uploadedArchivePath) {
        await rm(uploadedArchivePath, { force: true });
      }
    }
  }
}

export const orchestrator = new PipelineOrchestrator();
