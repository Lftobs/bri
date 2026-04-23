import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../utils/config';
import { dockerBin } from '../utils/docker-bin';

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr}`));
      }
    });
  });

const getCaddyContainer = async (): Promise<string> => {
  const output = await run(dockerBin, [
    'ps',
    '-q',
    '--filter',
    'label=com.docker.compose.service=caddy',
    '--filter',
    `network=${config.dockerNetwork}`
  ]);

  const containerId = output.split('\n').map((line) => line.trim()).find(Boolean);
  if (!containerId) {
    throw new Error('Could not find running Caddy container for compose project');
  }
  return containerId;
};

const tryRun = async (cmd: string, args: string[]) => {
  try {
    await run(cmd, args);
  } catch {
    return;
  }
};

const waitForRunningContainer = async (containerName: string, retries = 20) => {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const status = await run(dockerBin, [
        'inspect',
        '-f',
        '{{.State.Status}}',
        containerName
      ]);
      if (status.trim() === 'running') {
        return;
      }
    } catch {
      // ignore transient inspect errors during container startup
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Container ${containerName} did not reach running state in time`);
};

export const deployContainer = async (
  deploymentId: string,
  imageTag: string,
  onLog: (line: string) => Promise<void>
) => {
  const containerName = `deploy-${deploymentId}`;
  const routePath = `/apps/${deploymentId}`;
  const liveUrl = `${config.caddyIngressBase}${routePath}/`;

  await onLog(`Removing old container if present: ${containerName}`);
  await tryRun(dockerBin, ['rm', '-f', containerName]);

  await onLog(`Starting container ${containerName} from image ${imageTag}`);
  await run(dockerBin, [
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    config.dockerNetwork,
    '-e',
    `PORT=${config.appInternalPort}`,
    imageTag
  ]);

  await onLog(`Waiting for container ${containerName} to report running`);
  await waitForRunningContainer(containerName);

  const caddyRouteFile = join(config.caddyRoutesDir, `${deploymentId}.caddy`);
  const caddySnippet = `redir ${routePath} ${routePath}/
${routePath}/* {
  uri strip_prefix ${routePath}
  reverse_proxy ${containerName}:${config.appInternalPort}
}
`;

  await onLog(`Writing Caddy route file: ${caddyRouteFile}`);
  await writeFile(caddyRouteFile, caddySnippet, 'utf8');

  await onLog('Reloading Caddy to apply dynamic route');
  const caddyContainer = await getCaddyContainer();
  await run(dockerBin, ['exec', caddyContainer, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
  await onLog('Caddy route reload completed');

  await onLog(`Deployment reachable at ${liveUrl}`);

  return {
    containerName,
    routePath,
    liveUrl
  };
};
