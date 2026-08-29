const fs = require("fs");
const path = require("path");

class LocalStorageAdapter {
  constructor(root = path.join(process.cwd(), "storage", "uploads")) {
    this.root = path.resolve(root);
  }

  async ready() {
    await fs.promises.mkdir(this.root, { recursive: true });
  }

  assertInsideRoot(candidate) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage path escaped the storage root");
    }
    return resolved;
  }

  resolve(key) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      throw new Error("Invalid storage key");
    }
    return this.assertInsideRoot(path.join(this.root, key));
  }

  resolveFile(file) {
    if (!file?.storedName) throw new Error("Stored file key is missing");

    if (/^[a-zA-Z0-9._-]+$/.test(file.storedName)) {
      return this.resolve(file.storedName);
    }

    // v1 stored names included the original filename. Preserve compatibility
    // while still refusing traversal outside the configured storage root.
    return this.assertInsideRoot(path.join(this.root, file.storedName));
  }

  createWriteStream(key) {
    return fs.createWriteStream(this.resolve(key), { flags: "wx" });
  }

  createReadStream(key, options = {}) {
    return fs.createReadStream(this.resolve(key), options);
  }

  createReadStreamForFile(file, options = {}) {
    return fs.createReadStream(this.resolveFile(file), options);
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

  async existsFile(file) {
    try {
      await fs.promises.access(this.resolveFile(file), fs.constants.R_OK);
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

  async deleteFile(file) {
    try {
      await fs.promises.unlink(this.resolveFile(file));
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
