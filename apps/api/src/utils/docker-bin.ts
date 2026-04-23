import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const candidates = [
  process.env.DOCKER_BIN,
  '/usr/bin/docker',
  '/usr/bin/docker.io',
  '/usr/local/bin/docker',
  '/usr/local/bin/docker.io',
  '/bin/docker',
  '/bin/docker.io'
].filter(Boolean) as string[];

const isRunnableDocker = (bin: string): boolean => {
  if (!existsSync(bin)) {
    return false;
  }

  const probe = spawnSync(bin, ['--version'], {
    encoding: 'utf8'
  });

  return probe.status === 0;
};

export const resolveDockerBin = (): string => {
  for (const candidate of candidates) {
    if (isRunnableDocker(candidate)) {
      return candidate;
    }
  }

  const probe = spawnSync('sh', ['-lc', 'command -v docker || command -v docker.io'], {
    encoding: 'utf8'
  });
  if (probe.status === 0 && probe.stdout.trim()) {
    const resolved = probe.stdout.trim();
    if (isRunnableDocker(resolved)) {
      return resolved;
    }
  }

  throw new Error('Docker CLI binary not found or not executable in api container');
};

export const dockerBin = resolveDockerBin();
