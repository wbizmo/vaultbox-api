function toBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value || 0);
}

function formatBytes(value) {
  const bytes = toBigInt(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unitIndex = 0;
  let divisor = 1n;

  while (unitIndex < units.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n;
    unitIndex += 1;
  }

  if (unitIndex === 0) return `${bytes} B`;

  const scaledHundredths = (bytes * 100n) / divisor;
  const whole = scaledHundredths / 100n;
  const fraction = String(scaledHundredths % 100n).padStart(2, "0");

  return `${whole}.${fraction} ${units[unitIndex]}`;
}

module.exports = {
  formatBytes,
  toBigInt
};
