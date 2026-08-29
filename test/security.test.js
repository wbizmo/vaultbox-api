const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeDownloadName,
  contentDispositionAttachment,
  redactRequestUrl
} = require("../src/lib/security");

test("sanitizes path separators and response-splitting characters", () => {
  assert.equal(sanitizeDownloadName("../report\r\n.pdf"), ".._report  .pdf");
});

test("builds a safe attachment header", () => {
  const value = contentDispositionAttachment("quarterly report.pdf");
  assert.match(value, /^attachment;/);
  assert.match(value, /filename\*=UTF-8''quarterly%20report.pdf/);
});

test("redacts signed download credentials from logged URLs", () => {
  assert.equal(
    redactRequestUrl("/download/super-secret-token?x=1"),
    "/download/[redacted]?x=1"
  );
  assert.equal(
    redactRequestUrl("/x?token=abc&next=1"),
    "/x?token=[redacted]&next=1"
  );
});
