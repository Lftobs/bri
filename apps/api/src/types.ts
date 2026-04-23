export type DeploymentStatus =
  | 'pending'
  | 'building'
  | 'deploying'
  | 'running'
  | 'failed';

export type SourceType = 'git' | 'upload';

export interface Deployment {
  id: string;
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
