const { parentPort, workerData } = require('worker_threads');
const { convert } = require('./converter');

try {
  parentPort.postMessage({ ok: true, result: convert(workerData.xmlPath) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
