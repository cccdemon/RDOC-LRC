'use strict';

function ts() { return new Date().toISOString(); }
function log(tag, ...args)    { console.log(`${ts()} [${tag}]`, ...args); }
function logErr(tag, ...args) { console.error(`${ts()} [${tag}]`, ...args); }

module.exports = { log, logErr };
