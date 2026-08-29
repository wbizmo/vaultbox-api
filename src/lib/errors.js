class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function installErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = Number(error.statusCode) >= 400 ? Number(error.statusCode) : 500;
    const code = error.code && typeof error.code === "string"
      ? error.code
      : statusCode >= 500
        ? "INTERNAL_SERVER_ERROR"
        : "REQUEST_FAILED";

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Request failed");
    }

    const payload = {
      error: {
        code,
        message: statusCode >= 500 ? "Internal server error" : error.message,
        requestId: request.id
      }
    };

    if (error.details !== undefined && statusCode < 500) {
      payload.error.details = error.details;
    }

    return reply.code(statusCode).send(payload);
  });
}

module.exports = {
  AppError,
  installErrorHandler
};
