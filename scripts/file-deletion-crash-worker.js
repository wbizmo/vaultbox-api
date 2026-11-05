/*
 * Test support: a process that claims a file-deletion job and then hangs inside the storage call, so a test
 * can SIGKILL it mid-deletion (an abrupt crash that runs no cleanup) and prove that another worker
 * finishes the job once the lease lapses, without any double refund.
 *
 * Environment: LEASE_MS. Messages to the parent: { claimed: [{ fileId, attempts }] } once the storage call is
 * entered (the process then waits forever).
 */
const { processFileDeletions } = require("../src/lib/file-deletion");

const storage = {
  async deleteFile() {
    process.send({ inStorageCall: true });
    await new Promise(() => {});
  }
};

processFileDeletions(storage, { leaseMs: Number(process.env.LEASE_MS) || 1000, batchSize: 1 }).then(() => process.exit(0));
