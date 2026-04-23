import { rm } from 'node:fs/promises';
import { appendLog, getDeploymentById, updateDeploymentStatus } from '../db/repo';
import { logBus } from './log-bus';
import { buildWithRailpack } from './railpack';
import { prepareSourceWorkspace, prepareUploadWorkspace, cleanupWorkspace } from './source';
import { deployContainer } from './runtime';

const emitLog = async (
  deploymentId: string,
  stage: 'build' | 'deploy' | 'system',
  message: string
) => {
  const saved = await appendLog(deploymentId, stage, message);
  logBus.publish({
    deploymentId,
    sequence: saved.sequence,
    stage,
    message,
    timestamp: saved.createdAt
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

      await updateDeploymentStatus(deploymentId, 'building', { failureReason: null });
      await emitLog(deploymentId, 'build', `Preparing source (${deployment.sourceType})`);

      if (deployment.sourceType === 'git') {
        workspacePath = await prepareSourceWorkspace(deploymentId, deployment.sourceRef);
      } else {
        uploadedArchivePath = deployment.sourceRef;
        workspacePath = await prepareUploadWorkspace(deploymentId, deployment.sourceRef);
      }

      const imageTag = `brim-${deploymentId}:latest`;
      await buildWithRailpack(workspacePath, imageTag, async (line) => {
        await emitLog(deploymentId, 'build', line);
      });

      await updateDeploymentStatus(deploymentId, 'deploying', { imageTag });
      await emitLog(deploymentId, 'deploy', 'Starting container deployment');

      const runtime = await deployContainer(deploymentId, imageTag, async (line) => {
        await emitLog(deploymentId, 'deploy', line);
      });

      await updateDeploymentStatus(deploymentId, 'running', {
        imageTag,
        containerName: runtime.containerName,
        liveUrl: runtime.liveUrl,
        failureReason: null
      });
      await emitLog(deploymentId, 'system', 'Deployment is running');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown deployment failure';
      await emitLog(deploymentId, 'system', `Deployment failed: ${message}`);
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
