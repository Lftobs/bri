import { getDb } from './client';

export const migrate = async () => {
  const db = await getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      image_tag TEXT,
      container_name TEXT,
      route_path TEXT NOT NULL,
      live_url TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployment_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(deployment_id) REFERENCES deployments(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_dep_seq
      ON deployment_logs(deployment_id, sequence);
  `);
};
