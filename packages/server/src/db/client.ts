import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { config } from '../config.js';

export const pool = new Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, { schema });
