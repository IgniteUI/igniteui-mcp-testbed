'use strict';

const express = require('express');
const path = require('path');
const { ARTIFACT_DIR } = require('./config');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// Serve matrix screenshot artifacts read-only from the persistent history store.
app.use('/history/artifacts', express.static(ARTIFACT_DIR));

require('./routes/run')(app);
require('./routes/matrix')(app);
require('./routes/history')(app);
require('./routes/stats')(app);

module.exports = app;
