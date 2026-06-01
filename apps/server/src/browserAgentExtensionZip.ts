import { BROWSER_AGENT_EXTENSION_SOURCE_DIR_NAME } from "@t3tools/shared/browserAgent";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

interface ZipSourceFile {
  readonly zipPath: string;
  readonly data: Buffer;
}

interface ZipCentralDirectoryEntry {
  readonly fileNameBytes: Buffer;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dosDate: number;
  readonly dosTime: number;
  readonly localHeaderOffset: number;
}

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY_UNIX = 0x0314;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const SKIPPED_ENTRY_NAMES = new Set([".DS_Store", "__MACOSX"]);
const ZIP_DEFAULT_DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
const ZIP_DEFAULT_DOS_TIME = 0;

export class BrowserAgentExtensionZipError extends Data.TaggedError(
  "BrowserAgentExtensionZipError",
)<{
  readonly message: string;
}> {}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i += 1) {
  let crc = i;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  CRC32_TABLE[i] = crc >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertZipUInt16(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT16) {
    throw new Error(`${label} is too large for ZIP32.`);
  }
}

function assertZipUInt32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error(`${label} is too large for ZIP32.`);
  }
}

function writeUInt16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function buildLocalFileHeader(
  fileNameBytes: Buffer,
  file: ZipSourceFile,
  crc: number,
  dosDate: number,
  dosTime: number,
): Buffer {
  assertZipUInt16(fileNameBytes.length, "ZIP file name");
  assertZipUInt32(file.data.byteLength, "ZIP file");

  return Buffer.concat([
    writeUInt32(0x04034b50),
    writeUInt16(ZIP_VERSION_NEEDED),
    writeUInt16(ZIP_UTF8_FLAG),
    writeUInt16(ZIP_STORE_METHOD),
    writeUInt16(dosTime),
    writeUInt16(dosDate),
    writeUInt32(crc),
    writeUInt32(file.data.byteLength),
    writeUInt32(file.data.byteLength),
    writeUInt16(fileNameBytes.length),
    writeUInt16(0),
  ]);
}

function buildCentralDirectoryHeader(entry: ZipCentralDirectoryEntry): Buffer {
  assertZipUInt16(entry.fileNameBytes.length, "ZIP file name");
  assertZipUInt32(entry.compressedSize, "ZIP compressed size");
  assertZipUInt32(entry.uncompressedSize, "ZIP uncompressed size");
  assertZipUInt32(entry.localHeaderOffset, "ZIP local header offset");

  return Buffer.concat([
    writeUInt32(0x02014b50),
    writeUInt16(ZIP_VERSION_MADE_BY_UNIX),
    writeUInt16(ZIP_VERSION_NEEDED),
    writeUInt16(ZIP_UTF8_FLAG),
    writeUInt16(ZIP_STORE_METHOD),
    writeUInt16(entry.dosTime),
    writeUInt16(entry.dosDate),
    writeUInt32(entry.crc),
    writeUInt32(entry.compressedSize),
    writeUInt32(entry.uncompressedSize),
    writeUInt16(entry.fileNameBytes.length),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32((0o100644 << 16) >>> 0),
    writeUInt32(entry.localHeaderOffset),
  ]);
}

function buildEndOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
) {
  assertZipUInt16(entryCount, "ZIP entry count");
  assertZipUInt32(centralSize, "ZIP central directory size");
  assertZipUInt32(centralOffset, "ZIP central directory offset");

  return Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entryCount),
    writeUInt16(entryCount),
    writeUInt32(centralSize),
    writeUInt32(centralOffset),
    writeUInt16(0),
  ]);
}

const collectZipSourceFiles = Effect.fn("collectZipSourceFiles")(function* (
  sourceDir: string,
): Effect.fn.Return<
  ReadonlyArray<ZipSourceFile>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: ZipSourceFile[] = [];

  const visit = (
    currentDir: string,
    relativeDir: string,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const entryNames = yield* fileSystem.readDirectory(currentDir);
      entryNames.sort((left, right) => left.localeCompare(right));

      for (const entryName of entryNames) {
        if (SKIPPED_ENTRY_NAMES.has(entryName)) {
          continue;
        }

        const absolutePath = path.join(currentDir, entryName);
        const relativePath = relativeDir ? `${relativeDir}/${entryName}` : entryName;
        const fileInfo = yield* fileSystem.stat(absolutePath);

        if (fileInfo.type === "Directory") {
          yield* visit(absolutePath, relativePath);
          continue;
        }

        if (fileInfo.type !== "File") {
          continue;
        }

        const data = yield* fileSystem.readFile(absolutePath);
        files.push({
          zipPath: `${BROWSER_AGENT_EXTENSION_SOURCE_DIR_NAME}/${relativePath}`,
          data: Buffer.from(data),
        });
      }
    });

  yield* visit(sourceDir, "");
  return files;
});

export const createBrowserAgentExtensionZip = Effect.fn("createBrowserAgentExtensionZip")(
  function* (
    sourceDir: string,
  ): Effect.fn.Return<
    Uint8Array,
    BrowserAgentExtensionZipError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const files = yield* collectZipSourceFiles(sourceDir);
    const manifestPath = `${BROWSER_AGENT_EXTENSION_SOURCE_DIR_NAME}/manifest.json`;
    if (!files.some((file) => file.zipPath === manifestPath)) {
      return yield* new BrowserAgentExtensionZipError({
        message: `Browser agent extension manifest not found in ${sourceDir}.`,
      });
    }

    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    const centralEntries: ZipCentralDirectoryEntry[] = [];
    let offset = 0;

    for (const file of files) {
      const fileNameBytes = Buffer.from(file.zipPath, "utf8");
      const crc = crc32(file.data);
      const localHeader = buildLocalFileHeader(
        fileNameBytes,
        file,
        crc,
        ZIP_DEFAULT_DOS_DATE,
        ZIP_DEFAULT_DOS_TIME,
      );

      localParts.push(localHeader, fileNameBytes, file.data);
      centralEntries.push({
        fileNameBytes,
        crc,
        compressedSize: file.data.byteLength,
        uncompressedSize: file.data.byteLength,
        dosDate: ZIP_DEFAULT_DOS_DATE,
        dosTime: ZIP_DEFAULT_DOS_TIME,
        localHeaderOffset: offset,
      });

      offset += localHeader.byteLength + fileNameBytes.byteLength + file.data.byteLength;
      assertZipUInt32(offset, "ZIP local data offset");
    }

    for (const entry of centralEntries) {
      centralParts.push(buildCentralDirectoryHeader(entry), entry.fileNameBytes);
    }

    const centralDirectory = Buffer.concat(centralParts);
    const endOfCentralDirectory = buildEndOfCentralDirectory(
      centralEntries.length,
      centralDirectory.byteLength,
      offset,
    );

    return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
  },
);
