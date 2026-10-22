const zlib = require("node:zlib");

const UTF8_NAMES = 0x0800;
const MADE_BY_UNIX = (3 << 8) | 20;

/**
 * Builds a zip in memory, so tests can make archives no zip tool would write: any raw
 * path, a Unix mode (a symlink), or a declared size that understates the real data.
 * Entries: { path, data = "", mode = 0o100644, declaredSize, deflate }.
 */
function buildZip(entries) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const stored = entry.deflate ? zlib.deflateRawSync(data) : data;
    const method = entry.deflate ? 8 : 0;
    const crc = zlib.crc32(data);
    const size = entry.declaredSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

const endRecordAt = (zip) => zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

// Each end-record field that, at its largest value, sends a reader to the zip64 record.
const ZIP64_MARKERS = {
  entries: (end) => {
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
  },
  offset: (end) => end.writeUInt32LE(0xffffffff, 16),
  disk: (end) => end.writeUInt16LE(0xffff, 4),
};

/**
 * Makes the end record claim `count` entries through a zip64 record, as a forged file could.
 * `marker` names the end-record field that sends the reader there.
 */
function withClaimedEntries(zip, count, marker = "entries") {
  const at = endRecordAt(zip);
  const end = Buffer.from(zip.subarray(at));
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40);
  record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
  ZIP64_MARKERS[marker](end);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(at), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([zip.subarray(0, at), record, locator, end]);
}

/** Adds an archive comment after the end record. */
function withComment(zip, comment) {
  const at = endRecordAt(zip);
  const end = Buffer.from(zip.subarray(at));
  const text = Buffer.from(comment);
  end.writeUInt16LE(text.length, 20);
  return Buffer.concat([zip.subarray(0, at), end, text]);
}

module.exports = { buildZip, withClaimedEntries, withComment };
