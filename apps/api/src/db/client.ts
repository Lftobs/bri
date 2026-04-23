import { Database } from 'bun:sqlite';
import { config } from '../utils/config';

let db: Database | null = null;

export const getDb = async () => {
  if (!db) {
    db = new Database(config.databasePath, { create: true });
  }
  return db;
};
