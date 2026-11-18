const { app } = require('electron');
const path = require('node:path');
app.setPath('userData', process.env.POINT_VIEW_VALIDATION_PROFILE || path.join(require('node:os').tmpdir(), 'point-view-object-validation-' + process.pid));
require('../../electron/main.cjs');
