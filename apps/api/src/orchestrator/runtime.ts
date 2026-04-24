import {
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "../utils/config";
import { dockerBin } from "../utils/docker-bin";

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      if (code === 0) {
        const out = (
          stdout +
          "\n" +
          stderr
        ).trim();
        resolve(out);
      } else {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed (${code}): ${stderr}`,
          ),
        );
      }
    });
  });

const getCaddyContainer =
  async (): Promise<string> => {
    const output = await run(dockerBin, [
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.service=caddy",
      "--filter",
      `network=${config.dockerNetwork}`,
    ]);

    const containerId = output
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!containerId) {
      throw new Error(
        "Could not find running Caddy container for compose project",
      );
    }
    return containerId;
  };

const tryRun = async (
  cmd: string,
  args: string[],
) => {
  try {
    await run(cmd, args);
  } catch {
    return;
  }
};

const waitForRunningContainer = async (
  containerName: string,
  retries: number,
  onLog: (line: string) => Promise<void>,
) => {
  for (
    let attempt = 0;
    attempt < retries;
    attempt += 1
  ) {
    try {
      const status = await run(dockerBin, [
        "inspect",
        "-f",
        "{{.State.Status}}",
        containerName,
      ]);
      const trimmed = status.trim();
      if (trimmed === "running") {
        // Simple stability wait to ensure it doesn't crash 1 second later
        await new Promise((resolve) =>
          setTimeout(resolve, 2000),
        );

        // Re-check after 2 seconds
        const stabilityStatus = await run(
          dockerBin,
          [
            "inspect",
            "-f",
            "{{.State.Status}}",
            containerName,
          ],
        );
        if (
          stabilityStatus.trim() !==
          "running"
        ) {
          const logs = await run(
            dockerBin,
            [
              "logs",
              "--tail",
              "50",
              containerName,
            ],
          ).catch(
            () => "no logs available",
          );
          throw new Error(
            `Container crashed shortly after starting. Logs:\n${logs}`,
          );
        }
        return;
      }
      if (trimmed === "exited") {
        let logs = await run(dockerBin, [
          "logs",
          "--tail",
          "50",
          containerName,
        ]).catch(
          () => "no logs available",
        );
        logs =
          logs.trim() ||
          "*No logs produced by container*";
        throw new Error(
          `Container ${containerName} exited immediately. Logs:\n${logs}`,
        );
      }
      if (trimmed === "created") {
        await onLog(
          `Container ${containerName} still initializing...`,
        );
      }
    } catch (e: any) {
      if (
        e.message &&
        e.message.includes(
          "exited immediately",
        )
      ) {
        throw e;
      }
      if (
        e.message &&
        e.message.includes(
          "Container crashed",
        )
      ) {
        throw e;
      }
      // ignore transient inspect errors during container startup
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 500),
    );
  }

  await onLog(
    `Container ${containerName} did not reach running state — attempting docker start`,
  );
  try {
    await run(dockerBin, [
      "start",
      containerName,
    ]);
    await onLog(
      `docker start ${containerName} completed — proceeding with deployment`,
    );
  } catch (startError) {
    await onLog(
      `docker start failed: ${String(startError)} — proceeding anyway`,
    );
  }

  await onLog(
    `Connecting container to ${config.dockerNetwork}`,
  );
  await tryRun(dockerBin, [
    "network",
    "connect",
    config.dockerNetwork,
    containerName,
  ]);
};

export const ensureContainerRunning = async (
  containerName: string,
) => {
  try {
    const status = await run(dockerBin, [
      "inspect",
      "-f",
      "{{.State.Status}}",
      containerName,
    ]);
    if (status.trim() !== "running") {
      await run(dockerBin, [
        "start",
        containerName,
      ]);
    }
    // ensure network is connected
    await tryRun(dockerBin, [
      "network",
      "connect",
      config.dockerNetwork,
      containerName,
    ]);
  } catch (error) {
    console.error(
      `Failed to reconcile container ${containerName}:`,
      error,
    );
  }
};

export const reloadCaddy = async () => {
  const caddyContainer =
    await getCaddyContainer();
  await run(dockerBin, [
    "exec",
    caddyContainer,
    "caddy",
    "reload",
    "--config",
    "/etc/caddy/Caddyfile",
  ]);
};

export const deployContainer = async (
  deploymentId: string,
  imageTag: string,
  onLog: (line: string) => Promise<void>,
  opts: {
    projectId?: string;
    oldContainerName?: string;
  } = {},
) => {
  const containerName = `deploy-${deploymentId}`;


  const slug = opts.projectId || deploymentId;
  const liveUrl = `http://${slug}.localhost`;

  await onLog(
    `Starting container ${containerName} from image ${imageTag}`,
  );
  await run(dockerBin, [
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    config.dockerNetwork,
    "-e",
    `PORT=${config.appInternalPort}`,
    imageTag,
  ]);

  await onLog(
    `Waiting for container ${containerName} to report running`,
  );
  await waitForRunningContainer(
    containerName,
    40,
    onLog,
  );

  await onLog(
    `Connecting container to ${config.dockerNetwork}`,
  );
  await tryRun(dockerBin, [
    "network",
    "connect",
    config.dockerNetwork,
    containerName,
  ]);

  const caddyRouteFile = join(
    config.caddyRoutesDir,
    `${slug}.caddy`,
  );
  const caddySnippet = `${slug}.localhost:80 {
  reverse_proxy ${containerName}:${config.appInternalPort}
}
`;

  await onLog(
    `Writing Caddy route file: ${caddyRouteFile}`,
  );
  await writeFile(
    caddyRouteFile,
    caddySnippet,
    "utf8",
  );

  await onLog(
    "Reloading Caddy to apply dynamic route",
  );
  try {
    await reloadCaddy();
  } catch (error) {
    await onLog(
      `Caddy reload failed (might not be ready): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await onLog("Caddy route reload completed");

  if (
    opts.oldContainerName &&
    opts.oldContainerName !== containerName
  ) {
    await onLog(
      `Gracefully stopping old container: ${opts.oldContainerName}`,
    );
    await tryRun(dockerBin, [
      "stop",
      "-t",
      "10",
      opts.oldContainerName,
    ]);
    await tryRun(dockerBin, [
      "rm",
      "-f",
      opts.oldContainerName,
    ]);
    await onLog(
      `Old container ${opts.oldContainerName} removed`,
    );
  }

  await onLog(
    `Deployment reachable at ${liveUrl}`,
  );

  return {
    containerName,
    routePath: `/apps/${slug}`,
    liveUrl,
  };
};
