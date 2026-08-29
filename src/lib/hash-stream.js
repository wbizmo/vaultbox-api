const crypto = require("crypto");
const { Transform } = require("stream");

class HashingTransform extends Transform {
  constructor(algorithm = "sha256") {
    super();
    this.hash = crypto.createHash(algorithm);
    this.bytes = 0n;
    this.digestValue = null;
  }

  _transform(chunk, encoding, callback) {
    this.hash.update(chunk);
    this.bytes += BigInt(chunk.length);
    callback(null, chunk);
  }

  _flush(callback) {
    this.digestValue = this.hash.digest("hex");
    callback();
  }

  digest() {
    if (!this.digestValue) {
      throw new Error("Hash is not available until the stream finishes");
    }
    return this.digestValue;
  }
}

module.exports = { HashingTransform };
