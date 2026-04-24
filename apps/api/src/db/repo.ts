import { randomUUID } from 'node:crypto';
import { getDb } from './client';
import type { CreateDeploymentInput, Deployment, DeploymentLog, DeploymentStatus, LogEvent } from '../types';

const mapDeployment = (row: any): Deployment => ({
  id: row.id,
  projectId: row.project_id,
  sourceType: row.source_type,
  sourceRef: row.source_ref,
  status: row.status,
  imageTag: row.image_tag,
  containerName: row.container_name,
  routePath: row.route_path,
  liveUrl: row.live_url,
  failureReason: row.failure_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const now = () => new Date().toISOString();

export const createDeployment = async (input: CreateDeploymentInput): Promise<Deployment> => {
  const db = await getDb();
  const id = randomUUID();
  const timestamp = now();
  const routePath = `/apps/${id}`;

  db.query(
    `INSERT INTO deployments
      (id, project_id, source_type, source_ref, status, route_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.projectId ?? null, input.sourceType, input.sourceRef, 'pending', routePath, timestamp, timestamp);

  const created = db.query('SELECT * FROM deployments WHERE id = ?').get(id);
  return mapDeployment(created);
};

export const listDeployments = async (): Promise<Deployment[]> => {
  const db = await getDb();
  const rows = db.query('SELECT * FROM deployments ORDER BY created_at DESC').all();
  return rows.map(mapDeployment);
};

export const getDeploymentById = async (id: string): Promise<Deployment | null> => {
  const db = await getDb();
  const row = db.query('SELECT * FROM deployments WHERE id = ?').get(id);
  return row ? mapDeployment(row) : null;
};

export const updateDeploymentStatus = async (
  id: string,
  status: DeploymentStatus,
  patch: Partial<Pick<Deployment, 'imageTag' | 'containerName' | 'liveUrl' | 'failureReason'>> = {}
) => {
  const db = await getDb();
  const updatedAt = now();
  db.query(
    `UPDATE deployments
     SET status = ?,
         image_tag = COALESCE(?, image_tag),
         container_name = COALESCE(?, container_name),
         live_url = COALESCE(?, live_url),
         failure_reason = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    patch.imageTag ?? null,
    patch.containerName ?? null,
    patch.liveUrl ?? null,
    patch.failureReason ?? null,
    updatedAt,
    id
  );
};

export const appendLog = async (
  deploymentId: string,
  stage: LogEvent['stage'],
  message: string
): Promise<DeploymentLog> => {
  const db = await getDb();
  const createdAt = now();
  const row = db.query(
    'SELECT COALESCE(MAX(sequence), 0) as max_sequence FROM deployment_logs WHERE deployment_id = ?',
  ).get(deploymentId);
  const sequence = Number(row.max_sequence) + 1;

  const result = db.query(
    `INSERT INTO deployment_logs (deployment_id, sequence, stage, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(deploymentId, sequence, stage, message, createdAt);

  return {
    id: Number(result.lastInsertRowid),
    deploymentId,
    sequence,
    stage,
    message,
    createdAt
  };
};

export const getLogs = async (deploymentId: string): Promise<DeploymentLog[]> => {
  const db = await getDb();
  const rows = db.query(
    `SELECT id, deployment_id, sequence, stage, message, created_at
     FROM deployment_logs
     WHERE deployment_id = ?
     ORDER BY sequence ASC`,
  ).all(deploymentId);

  return rows.map((row: any) => ({
    id: row.id,
    deploymentId: row.deployment_id,
    sequence: row.sequence,
    stage: row.stage,
    message: row.message,
    createdAt: row.created_at
  }));
};
