'use strict';

const fs = require('fs');
const path = require('path');

// Remove deselected skill folders (granular skills on/off).
function pruneSkills(excluded, emit, appDir) {
  const base = path.join(appDir, '.claude', 'skills');
  if (!fs.existsSync(base)) return;
  for (const name of excluded) {
    const dir = path.join(base, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      emit('log', `pruned skill: ${name}`);
    }
  }
}

module.exports = { pruneSkills };
