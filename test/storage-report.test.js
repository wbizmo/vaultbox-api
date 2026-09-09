const test = require("node:test");
const assert = require("node:assert/strict");

const { getStorageReport } = require("../src/lib/storage-report");

test("storage report is serviced by one filtered aggregate query", async () => {
  let calls = 0;
  let sql = "";
  const client = {
    $queryRaw: async (strings) => {
      calls += 1;
      sql = strings.join("?");
      return [{
        totalUsers: 6,
        activeUsers: 3,
        suspendedUsers: 2,
        deletedUsers: 1,
        totalStorageUsed: 1234567890123456789n
      }];
    }
  };

  const report = await getStorageReport(client);
  assert.equal(calls, 1);
  assert.equal(report.totalUsers, report.activeUsers + report.suspendedUsers + report.deletedUsers);
  assert.equal(report.totalStorageUsed, 1234567890123456789n);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE "status" = 'ACTIVE'\)/);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE "status" = 'SUSPENDED'\)/);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE "status" = 'DELETED'\)/);
  assert.match(sql, /SUM\("storageUsed"\)/);
});

test("storage report preserves the zero-user shape", async () => {
  const client = {
    $queryRaw: async () => [{
      totalUsers: 0,
      activeUsers: 0,
      suspendedUsers: 0,
      deletedUsers: 0,
      totalStorageUsed: 0n
    }]
  };

  assert.deepEqual(await getStorageReport(client), {
    totalUsers: 0,
    activeUsers: 0,
    suspendedUsers: 0,
    deletedUsers: 0,
    totalStorageUsed: 0n
  });
});
