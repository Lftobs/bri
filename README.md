# Brim

Brim is a container deployment orchestration platform that allows users to deploy applications effortlessly using [Railpack](https://railway.app/railpack). It automatically manages application builds, persistent deployments, and dynamic routing.

## Architecture

The platform architecture is structured around a multi-container Docker Compose setup (`docker-compose.yml`), featuring the following core services:

1. **`buildkit`**: A dedicated `moby/buildkit` daemon used to execute Railpack container builds efficiently.
2. **`api`** (Bun + ElysiaJS): The backend orchestration engine. It exposes the REST API under `/api/*` and orchestrates the deployment lifecycle:
   - Evaluates source targets (Git repositories or uploaded archives).
   - Engages the Railpack CLI (via Docker buildx) to infer and build application images without requiring a `Dockerfile`.
   - Provisions running containers on the internal Docker network (`brim_net`).
   - Dynamically writes Caddy reverse proxy configurations and reloads the Caddy daemon to map subdomains (e.g., `<deploymentId>.localhost`).
   - It maintains deployment states in a local SQLite database (`data/brim.db`) and supports system-startup state reconciliation.
3. **`web`** (React + Vite + TanStack Query/Router): The frontend dashboard for overseeing project deployments. Served as the root entry point.
4. **`caddy`**: The reverse proxy acting as the unified ingress controller mapping:
   - `/api/*` to the `api` service.
   - `/*` to the `web` service.
   - `<deploymentId>.localhost` to individual user-deployed containers dynamically.

## Prerequisites

- **Docker** and **Docker Compose** installed on your system.
- Optional: **Bun** installed globally if you wish to run/develop the local apps without Docker.

## Local Setup & Execution

### 1. Starting the Platform

Boot the entire platform (Buildkit daemon, API, Web Interface, and Caddy Server) by running Docker compose from the root directory:

```bash
docker-compose up -d --build
```

This will:
- Build the `api` and `web` internal images.
- Mount necessary workspace and data volumes (`./data`, `./workspace`, `./infra/caddy/routes`).
- Mount `/var/run/docker.sock` to the `api` container providing it access to Docker APIs.

### 2. Accessing the Platform

- **Web Dashboard**: Open `http://localhost`
- **API Endpoints**: Accessible via `http://localhost/api/...`

### 3. Deployments Ingress

When applications are successfully built and deployed via Railpack orchestration, they are automatically allocated a subdomain. 
For a deployment with ID `xyz`, you can view the live application at:
```
http://xyz.localhost
```

## Directory Structure
- `apps/api/`: Backend orchestrator service (Bun/ElysiaJS). Contains deployment queueing, build pipelines (`Railpack`), and Docker runtime control logic.
- `apps/web/`: Frontend dashboard service (Vite/React).
- `infra/caddy/`: Setup for the global ingress path and holding target directory (`routes/`) for deployment-specific Caddyfiles.
- `data/`: Persisted SQLite database files (e.g., `brim.db`).
- `workspace/`: Temporary staging area for preparing source files and extracting archives before they are evaluated by Railpack.

## How it Works (The Pipeline Orchestrator)

The deployment logic relies on a localized Queue mechanism (`apps/api/src/orchestrator/pipeline.ts`).
1. **Source Prep**: The API fetches code (Git clone or extracting an archive upload) into `./workspace/<deploymentId>`.
2. **Build**: The API invokes the `railpack build` CLI targeting the workspace directory. Railpack automatically detects the application stack, installs dependencies, sets up start commands, and builds a Docker image (`brim-<deploymentId>:latest`).
3. **Runtime Creation**: A container named `deploy-<deploymentId>` is launched from the image and bound to the `brim_net` Docker network.
4. **Ingress Attachment**: A distinct `<deploymentId>.caddy` routing file is spawned routing traffic from `<deploymentId>.localhost:80` to the internal port of the deployed container. Caddy is dynamically reloaded via `docker exec`.

## Implementation Choices & Trade-offs

During the development and stabilization of the deployment orchestration pipeline, several deliberate architectural choices were made:

1. **Subdomain vs. Path-Based Routing**: 
   Initially, i mapped dynamic deployments to `/apps/<id>`. i eventually replaced with subdomain routing (`<id>.localhost`). Path-based routing often breaks Single Page Applications (SPAs) because their relative asset paths expect to operate at the URL root (e.g., `/assets/main.js` instead of `/apps/<id>/assets/main.js`). Subdomains provide immediate, pure isolation that mimics production SaaS deployments (like Vercel or Railway).

2. **Wait-and-Verify Container Health Strategy**: 
   A common issue in direct `docker run` orchestration is asynchronous failure: the CLI reports the container has started successfully, but an app-level error causes the container to quietly exit milliseconds later. To fix "silent deployments", a stability check was added: the pipeline now waits for the `running` state, then manually loops back 2 seconds later to verify it is *still* running, aggressively catching quick-crash logs (like missing dependencies) and bubbling them back to the user interface.

3. **Archive Metadata Stripping**:
   When users upload `.zip` archives (especially those compressed on macOS), they frequently include `__MACOSX` directories or hidden files like `.DS_Store`. The `ensureSingleRoot` extraction phase was explicitly updated to filter out these hidden artifacts so the pipeline reliably discovers the actual application folder that Railpack needs to scan.

4. **Boot-time State Reconciliation**:
   Because the API orchestrator provisions containers *imperatively* over the Docker daemon instead of declaratively via Compose, a system reboot would kill all user applications. I tackled this by adding a "wake-up" loop in `pipeline.ts`: when the API server boots, it polls the SQLite database for successful deployments, cross-references against running Docker containers, auto-restarts the missing ones (`docker start`), and re-attaches them meticulously to the `brim_net` proxy network.

## What I'd do with more time

1. **Host-Level Garbage Collection (Images & Containers)**: 
   Currently, every iteration builds a new Docker footprint via Buildkit (`brim-<id>:latest`). Over time, this will exhaust the host's disk space. I'd add an asynchronous cron job that triggers `docker image prune` or manages an aggressive cleanup phase when old deployments are intentionally archived or superseded.

2. **Distributed Nodes via Docker HTTP API**:
   Presently, the orchestrator passes instructions to Docker CLI binary locally, binding via a mounted `/var/run/docker.sock`. This restricts horizontal scaling. With more time, I would swap this imperative execution for the native Docker Engine HTTP API. This would allow `api` nodes to provision deployments onto physically remote edge machines.

3. **Compute Constraints & Isolation Profiles**:
   For multi-tenant security and stability, running user-uploaded arbitrary code should not happen in boundless environments. I would inject strict flag limits (`--memory=512m --cpus=0.5` and read-only filesystems where possible) into the orchestrator logic to prevent a single buggy deployment from crashing the orchestrator node.
