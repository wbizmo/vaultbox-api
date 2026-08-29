const fs = require("fs");
const path = require("path");

class LocalStorageAdapter {
  constructor(root = path.join(process.cwd(), "storage", "uploads")) {
    this.root = path.resolve(root);
  }

  async ready() {
    await fs.promises.mkdir(this.root, { recursive: true });
  }

  resolve(key) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      throw new Error("Invalid storage key");
    }

    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage key escaped the storage root");
    }

    return resolved;
  }

  createWriteStream(key) {
    return fs.createWriteStream(this.resolve(key), { flags: "wx" });
  }

  createReadStream(key, options = {}) {
    return fs.createReadStream(this.resolve(key), options);
  }

  async stat(key) {
    return fs.promises.stat(this.resolve(key));
  }

  async exists(key) {
    try {
      await fs.promises.access(this.resolve(key), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key) {
    try {
      await fs.promises.unlink(this.resolve(key));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
}

const storage = new LocalStorageAdapter();

module.exports = {
  LocalStorageAdapter,
  storage
};
