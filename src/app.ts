'use strict';

import express from 'express';
import * as path from 'path';
import { ARTIFACT_DIR } from './config.ts';
import registerRunRoutes from './routes/run.ts';
import registerMatrixRoutes from './routes/matrix.ts';
import registerHistoryRoutes from './routes/history.ts';
import registerStatsRoutes from './routes/stats.ts';
import registerSkillsRoutes from './routes/skills.ts';
import registerProviderRoutes from './routes/providers.ts';
import registerTestsRoutes from './routes/tests.ts';

const app = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
// Serve matrix screenshot artifacts read-only from the persistent history store.
app.use('/history/artifacts', express.static(ARTIFACT_DIR));

registerRunRoutes(app);
registerMatrixRoutes(app);
registerHistoryRoutes(app);
registerStatsRoutes(app);
registerSkillsRoutes(app);
registerProviderRoutes(app);
registerTestsRoutes(app);

export default app;
