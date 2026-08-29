function sanitizeDownloadName(name) {
  const cleaned = String(name || "download")
    .replace(/[\r\n]/g, " ")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 180);

  return cleaned || "download";
}

function contentDispositionAttachment(name) {
  const safe = sanitizeDownloadName(name).replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(sanitizeDownloadName(name));
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

function installSecurityHeaders(app) {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Cross-Origin-Resource-Policy", "same-site");

    if (request.protocol === "https") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    return payload;
  });
}

module.exports = {
  sanitizeDownloadName,
  contentDispositionAttachment,
  installSecurityHeaders
};
