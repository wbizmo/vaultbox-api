const { performance } = require("perf_hooks");

const state = {
  requests: 0,
  errors: 0,
  totalDurationMs: 0,
  byStatusClass: {
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0
  }
};

function statusClass(statusCode) {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  return "2xx";
}

function installRequestMetrics(app) {
  app.addHook("onRequest", async (request) => {
    request.vaultboxStartedAt = performance.now();
  });

  app.addHook("onResponse", async (request, reply) => {
    const durationMs = performance.now() - (request.vaultboxStartedAt || performance.now());
    state.requests += 1;
    state.totalDurationMs += durationMs;
    state.byStatusClass[statusClass(reply.statusCode)] += 1;
    if (reply.statusCode >= 500) state.errors += 1;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const durationMs = performance.now() - (request.vaultboxStartedAt || performance.now());
    reply.header("Server-Timing", `app;dur=${durationMs.toFixed(2)}`);
    reply.header("X-Request-Id", request.id);
    return payload;
  });
}

function snapshotMetrics() {
  return {
    requests: state.requests,
    errors: state.errors,
    averageDurationMs: state.requests > 0
      ? Number((state.totalDurationMs / state.requests).toFixed(3))
      : 0,
    byStatusClass: { ...state.byStatusClass },
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    memory: process.memoryUsage()
  };
}

module.exports = {
  installRequestMetrics,
  snapshotMetrics
};
