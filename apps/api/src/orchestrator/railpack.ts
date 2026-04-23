import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { dockerBin } from '../utils/docker-bin';

export interface RailpackBuildResult {
  imageTag: string;
}

const buildTimeoutMs = Number(process.env.RAILPACK_BUILD_TIMEOUT_MS ?? '0');
const buildExportMode = process.env.RAILPACK_BUILD_EXPORT_MODE ?? 'docker';

const spawnAsync = (
  cmd: string,
  args: string[],
  opts?: {
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
    onTimeout?: () => void;
  }
): Promise<{ stdout: string; stderr: string; code: number }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts?.env ?? process.env,
      cwd: opts?.cwd
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout =
      opts?.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            opts.onTimeout?.();
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!settled) {
                child.kill('SIGKILL');
              }
            }, 10000);
          }, opts.timeoutMs)
        : null;

    const finish = (result?: { stdout: string; stderr: string; code: number }, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result!);
    };

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => finish(undefined, error));
    child.on('close', (code) => {
      if (opts?.timeoutMs && opts.timeoutMs > 0 && code === 143) {
        finish(undefined, new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
        return;
      }
      finish({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
    });
  });
};

export const buildWithRailpack = async (
  workspace: string,
  imageTag: string,
  onLog: (line: string) => Promise<void>
): Promise<RailpackBuildResult> => {
  const railpackPlanPath = `/tmp/railpack-plan.json`;
  const railpackInfoPath = `/tmp/railpack-info.json`;
  const buildkitFrontend = process.env.BUILDKIT_FRONTEND ?? 'ghcr.io/railwayapp/railpack-frontend';

  await onLog(`[1/3] Generating Railpack build plan...`);

  const prep = await spawnAsync(
    'railpack',
    ['prepare', '--plan-out', railpackPlanPath, '--info-out', railpackInfoPath, workspace],
    { env: { ...process.env, BUILDKIT_HOST: process.env.BUILDKIT_HOST } }
  );

  if (prep.code !== 0) {
    throw new Error(`railpack prepare failed: ${prep.stderr}`);
  }

  await onLog(`[2/3] Building image via BuildKit frontend (${buildkitFrontend})...`);

  const outputArg =
    buildExportMode === 'oci'
      ? `type=oci,dest=/tmp/${imageTag.replace(/[^a-zA-Z0-9_.-]/g, '_')}.oci.tar`
      : `type=docker,name=${imageTag}`;

  const build = await spawnAsync(
    dockerBin,
    [
      'buildx', 'build',
      '--build-arg', `BUILDKIT_SYNTAX=${buildkitFrontend}`,
      '-f', railpackPlanPath,
      '--output', outputArg,
      '--progress', 'plain',
      workspace
    ],
    {
      env: { ...process.env, BUILDKIT_HOST: process.env.BUILDKIT_HOST },
      timeoutMs: buildTimeoutMs > 0 ? buildTimeoutMs : undefined,
      onTimeout: () => {
        void onLog(`Railpack build timed out after ${Math.floor(buildTimeoutMs / 1000)}s`);
      }
    }
  );

  if (build.code !== 0) {
    throw new Error(`docker buildx build failed: ${build.stderr}`);
  }

  if (buildExportMode === 'oci') {
    const ociTar = `/tmp/${imageTag.replace(/[^a-zA-Z0-9_.-]/g, '_')}.oci.tar`;
    await onLog(`[3/3] Loading OCI archive into Docker daemon...`);
    const load = await spawnAsync(dockerBin, ['load', '-i', ociTar], {
      timeoutMs: buildTimeoutMs > 0 ? buildTimeoutMs : undefined,
      onTimeout: () => {
        void onLog(`Docker load timed out after ${Math.floor(buildTimeoutMs / 1000)}s`);
      }
    });
    if (load.code !== 0) {
      throw new Error(`docker load failed: ${load.stderr}`);
    }
    await unlink(ociTar).catch(() => {});
  }

  await onLog(`[3/3] Verifying image ${imageTag} in Docker daemon...`);
  const imageId = await spawnAsync(dockerBin, ['images', '-q', '-f', `reference=${imageTag}`]);
  if (!imageId.stdout.trim()) {
    throw new Error(`build succeeded but ${imageTag} not found in local images`);
  }

  await onLog(`Cleanup temporary build plan files`);
  await unlink(railpackPlanPath).catch(() => {});
  await unlink(railpackInfoPath).catch(() => {});

  await onLog(`Railpack build completed: ${imageTag} (${imageId.stdout.trim().slice(0, 12)})`);
  return { imageTag };
};
