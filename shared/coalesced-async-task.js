function createCoalescedAsyncTask(task) {
  if (typeof task !== 'function') {
    throw new TypeError('coalesced async task requires a function');
  }

  let activePromise = null;
  let rerunRequested = false;

  function run() {
    if (activePromise) {
      rerunRequested = true;
      return activePromise;
    }

    activePromise = (async () => {
      try {
        while (true) {
          rerunRequested = false;
          let failure = null;
          try {
            await Promise.resolve().then(task);
          } catch (error) {
            failure = error;
          }
          if (failure && !rerunRequested) throw failure;
          if (!rerunRequested) return;
        }
      } finally {
        activePromise = null;
      }
    })();
    return activePromise;
  }

  run.isRunning = () => Boolean(activePromise);
  return run;
}

module.exports = {
  createCoalescedAsyncTask,
};
