// Test-only preload: force the startup race before the readiness write returns.
// No deferred callback: an unprotected runner must fail this regression.
const signal = process.env.FIRST_BITE_TEST_READY_SIGNAL;
if (!['SIGINT', 'SIGTERM'].includes(signal)) throw new Error('Invalid test signal');
const write = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  const result = Reflect.apply(write, this, [chunk, ...args]);
  if (String(chunk).includes('Live sending: disabled')) {
    process.stdout.write = write;
    process.kill(process.pid, signal);
  }
  return result;
};
