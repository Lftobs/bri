import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient
} from '@tanstack/react-query';
import { RouterProvider, createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import './styles.css';

type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed';

type Deployment = {
  id: string;
  sourceType: 'git' | 'upload';
  sourceRef: string;
  status: DeploymentStatus;
  imageTag: string | null;
  liveUrl: string | null;
  failureReason: string | null;
  createdAt: string;
};

type Log = {
  id: number;
  deploymentId: string;
  sequence: number;
  stage: 'build' | 'deploy' | 'system';
  message: string;
  createdAt: string;
};

const queryClient = new QueryClient();

const api = {
  listDeployments: async (): Promise<Deployment[]> => {
    const res = await fetch('/api/deployments');
    if (!res.ok) {
      throw new Error('Failed to list deployments');
    }
    return res.json();
  },
  createDeployment: async (payload: FormData): Promise<Deployment> => {
    const res = await fetch('/api/deployments', {
      method: 'POST',
      body: payload
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Failed to create deployment');
    }
    return res.json();
  },
  getLogs: async (id: string): Promise<Log[]> => {
    const res = await fetch(`/api/deployments/${id}/logs`);
    if (!res.ok) {
      throw new Error('Failed to fetch logs');
    }
    return res.json();
  }
};

function useDeploymentLogs(deploymentId: string | null) {
  const [liveLogs, setLiveLogs] = React.useState<Log[]>([]);

  const history = useQuery({
    queryKey: ['logs', deploymentId],
    queryFn: () => api.getLogs(deploymentId as string),
    enabled: Boolean(deploymentId),
    refetchOnWindowFocus: false,
    staleTime: Infinity
  });

  React.useEffect(() => {
    setLiveLogs([]);
    if (!deploymentId) {
      return;
    }

    const stream = new EventSource(`/api/deployments/${deploymentId}/logs/stream`);
    stream.addEventListener('log', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      setLiveLogs((prev) => [
        ...prev,
        {
          id: Number(payload.sequence),
          deploymentId,
          sequence: payload.sequence,
          stage: payload.stage,
          message: payload.message,
          createdAt: payload.timestamp
        }
      ]);
    });

    return () => {
      stream.close();
    };
  }, [deploymentId]);

  const merged = React.useMemo(() => {
    const base = history.data ?? [];
    const dedup = new Map<number, Log>();
    for (const log of base) {
      dedup.set(log.sequence, log);
    }
    for (const log of liveLogs) {
      dedup.set(log.sequence, log);
    }
    return Array.from(dedup.values()).sort((a, b) => a.sequence - b.sequence);
  }, [history.data, liveLogs]);

  return {
    logs: merged,
    isLoading: history.isLoading
  };
}

const statusColor: Record<DeploymentStatus, string> = {
  pending: '#8b8b8b',
  building: '#1d70b8',
  deploying: '#9c6f00',
  running: '#1a7f37',
  failed: '#b42318'
};

function AppPage() {
  const queryClient = useQueryClient();
  const [sourceType, setSourceType] = React.useState<'git' | 'upload'>('git');
  const [gitUrl, setGitUrl] = React.useState('');
  const [archive, setArchive] = React.useState<File | null>(null);
  const [selectedDeploymentId, setSelectedDeploymentId] = React.useState<string | null>(null);

  const deployments = useQuery({
    queryKey: ['deployments'],
    queryFn: api.listDeployments,
    refetchInterval: 2000
  });

  React.useEffect(() => {
    const first = deployments.data?.[0]?.id;
    if (!selectedDeploymentId && first) {
      setSelectedDeploymentId(first);
    }
  }, [deployments.data, selectedDeploymentId]);

  const createMutation = useMutation({
    mutationFn: api.createDeployment,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setSelectedDeploymentId(created.id);
    }
  });

  const logs = useDeploymentLogs(selectedDeploymentId);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData();
    form.append('sourceType', sourceType);

    if (sourceType === 'git') {
      form.append('gitUrl', gitUrl);
    } else if (archive) {
      form.append('archive', archive);
    }

    createMutation.mutate(form);
  };

  return (
    <main className="layout">
      <header>
        <h1>Deployment one-pager</h1>
        <p>Railpack build &rarr; Docker run &rarr; Caddy ingress</p>
      </header>

      <section className="panel">
        <h2>Create deployment</h2>
        <form onSubmit={onSubmit} className="form">
          <label>
            Source type
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value as 'git' | 'upload')}>
              <option value="git">Git URL</option>
              <option value="upload">Project upload</option>
            </select>
          </label>

          {sourceType === 'git' ? (
            <label>
              Git URL
              <input
                type="url"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                required
              />
            </label>
          ) : (
            <label>
              Archive (.zip/.tar/.tar.gz)
              <input
                type="file"
                onChange={(e) => setArchive(e.target.files?.[0] ?? null)}
                accept=".zip,.tar,.tgz,.tar.gz"
                required
              />
            </label>
          )}

          <button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Submitting...' : 'Create deployment'}
          </button>
          {createMutation.error ? <p className="error">{createMutation.error.message}</p> : null}
        </form>
      </section>

      <section className="panel">
        <h2>Deployments</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Image tag</th>
                <th>Live URL</th>
              </tr>
            </thead>
            <tbody>
              {(deployments.data ?? []).map((dep) => (
                <tr
                  key={dep.id}
                  onClick={() => setSelectedDeploymentId(dep.id)}
                  className={selectedDeploymentId === dep.id ? 'selected' : ''}
                >
                  <td>{dep.id.slice(0, 8)}</td>
                  <td>
                    <span style={{ color: statusColor[dep.status], fontWeight: 700 }}>{dep.status}</span>
                  </td>
                  <td>{dep.imageTag ?? '-'}</td>
                  <td>
                    {dep.liveUrl ? (
                      <a href={dep.liveUrl} target="_blank" rel="noreferrer">
                        open
                      </a>
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel logs">
        <h2>Logs {selectedDeploymentId ? `(${selectedDeploymentId.slice(0, 8)})` : ''}</h2>
        <div className="log-box">
          {logs.isLoading && <p>Loading logs...</p>}
          {logs.logs.map((log) => (
            <div key={`${log.sequence}-${log.createdAt}`} className="log-line">
              <span className="meta">[{log.sequence}] [{log.stage}]</span> {log.message}
            </div>
          ))}
          {!logs.logs.length && !logs.isLoading && <p>No logs yet.</p>}
        </div>
      </section>
    </main>
  );
}

const rootRoute = createRootRoute({
  component: () => <Outlet />
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AppPage
});

const routeTree = rootRoute.addChildren([indexRoute]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
