import type { Express } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { registerMyHeadRoutes, type RegisterMyHeadRoutesOptions } from './myhead-routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { corsMiddleware } from './middleware/cors.js';

export type CreateAppOptions = {
  webDistPath?: string | null;
  initialWorkspacePath?: string | null;
  routeOptions?: Omit<RegisterMyHeadRoutesOptions, 'initialWorkspacePath'>;
};

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());
  registerMyHeadRoutes(app, {
    ...options.routeOptions,
    initialWorkspacePath: options.initialWorkspacePath ?? null,
  });
  if (options.webDistPath && fs.existsSync(path.join(options.webDistPath, 'index.html'))) {
    app.use(express.static(options.webDistPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(options.webDistPath!, 'index.html'));
    });
  }
  app.use(errorHandler);
  return app;
}
