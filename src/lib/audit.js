/*
 * Audit policy (issue #48).
 *
 * CRITICAL events record a state change or a security decision. They are inserted with the caller's
 * transaction client, in the SAME transaction as the change, so the two always agree:
 *   - the change commits => its audit row exists (nothing can fail "after the commit");
 *   - the audit insert fails => the whole transaction rolls back, the client gets an error, and nothing
 *     happened, so retrying is safe and the error is not ambiguous.
 * There is no separate delivery step to lose, so there is no outbox backlog: the audit table is itself the
 * durable store, written atomically.
 *
 * BEST-EFFORT events describe something that happens AFTER a committed change and cannot be part of its
 * transaction (for example "the stored bytes could not be removed"). They are written after the response is
 * decided, never throw, and a failure is logged -- it must never turn a committed operation into an error.
 *
 * Details never carry file names, e-mail addresses or tokens: identifiers (file/session/user ids) and sizes
 * only; the referenced row holds the rest and is subject to the normal access rules.
 */

const MAX_DETAILS = 500;

function auditData({ action, userId = null, ip = null, details = null }) {
  const text = details === null || details === undefined ? null : String(details).slice(0, MAX_DETAILS);
  return { action, userId, ip, details: text };
}

/** Critical event: pass the transaction client of the change being audited. */
function recordAudit(tx, event) {
  return tx.auditLog.create({ data: auditData(event) });
}

/** Best-effort event: never throws. `log` is a pino-style logger (request.log). */
async function recordAuditBestEffort(client, event, log = null) {
  try {
    await client.auditLog.create({ data: auditData(event) });
    return true;
  } catch (error) {
    log?.error?.({ err: error, action: event.action }, "Best-effort audit event could not be recorded");
    return false;
  }
}

module.exports = { recordAudit, recordAuditBestEffort, auditData, MAX_DETAILS };
