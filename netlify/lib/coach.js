'use strict';
// The one account allowed to see the private admin numbers. Same address as the coach login in the app.
const COACH_EMAIL = (process.env.COACH_EMAIL || 'mitch@mitchnewman.com').toLowerCase();
module.exports = { COACH_EMAIL };
