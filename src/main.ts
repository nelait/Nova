import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { startServer } from './api/server.ts';

const root = join(import.meta.dirname, '..');
mkdirSync(join(root, 'data'), { recursive: true });
const app = createApp({ dbPath: process.env.DB_PATH ?? join(root, 'data', 'planops.db'), seedUsers: true });
startServer(app, Number(process.env.PORT ?? 3000), join(root, 'public'));
