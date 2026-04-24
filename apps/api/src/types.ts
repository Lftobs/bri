export type DeploymentStatus =
  | 'pending'
  | 'building'
  | 'deploying'
  | 'running'
  | 'failed'
  | 'inactive';

export type SourceType = 'git' | 'upload' | 'image';

export interface Deployment {
  id: string;
  projectId: string | null;
  sourceType: SourceType;
  sourceRef: string;
  status: DeploymentStatus;
  imageTag: string | null;
  containerName: string | null;
  routePath: string;
  liveUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentLog {
  id: number;
  deploymentId: string;
  sequence: number;
  stage: 'build' | 'deploy' | 'system';
  message: string;
  createdAt: string;
}

export interface CreateDeploymentInput {
  projectId?: string;
  sourceType: SourceType;
  sourceRef: string;
}

export interface LogEvent {
  deploymentId: string;
  sequence: number;
  stage: 'build' | 'deploy' | 'system';
  message: string;
  timestamp: string;
}
