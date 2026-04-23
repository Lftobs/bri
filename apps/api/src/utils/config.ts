const get = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const config = {
  port: Number(get('PORT', '3001')),
  databasePath: get('DATABASE_PATH', '/app/data/brim.db'),
  workspaceRoot: get('WORKSPACE_ROOT', '/app/workspace'),
  caddyRoutesDir: get('CADDY_ROUTES_DIR', '/caddy/routes'),
  caddyIngressBase: get('CADDY_INGRESS_BASE', 'http://localhost'),
  dockerNetwork: get('DOCKER_NETWORK', 'brim_net'),
  appInternalPort: Number(get('APP_INTERNAL_PORT', '3000')),
  buildkitHost: get('BUILDKIT_HOST', 'tcp://buildkit:1234')
};
