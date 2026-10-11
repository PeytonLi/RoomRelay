import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PermanentJobError } from "@roomrelay/jobs";

export interface ObjectReader {
  read(key: string, maxBytes: number): Promise<Uint8Array>;
}

export class LocalFsObjectReader implements ObjectReader {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async read(key: string, maxBytes: number): Promise<Uint8Array> {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.includes("\0") ||
      key.includes("\\") ||
      isAbsolute(key) ||
      /^[a-z]:/i.test(key) ||
      key.split("/").some((part) => part === "..")
    ) {
      throw new PermanentJobError("INVALID_OBJECT_KEY");
    }
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new PermanentJobError("INVALID_SIZE_LIMIT");
    }

    try {
      const root = await realpath(this.rootDir);
      const candidate = resolve(root, key);
      const pathWithinRoot = relative(root, candidate);
      if (
        pathWithinRoot === ".." ||
        pathWithinRoot.startsWith(`..${sep}`) ||
        isAbsolute(pathWithinRoot)
      ) {
        throw new PermanentJobError("INVALID_OBJECT_KEY");
      }

      const actualPath = await realpath(candidate);
      const actualRelativePath = relative(root, actualPath);
      if (
        actualRelativePath === ".." ||
        actualRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(actualRelativePath)
      ) {
        throw new PermanentJobError("INVALID_OBJECT_KEY");
      }
      const fileInfo = await stat(actualPath);
      if (!fileInfo.isFile()) throw new PermanentJobError("OBJECT_NOT_FOUND");
      if (fileInfo.size > maxBytes) throw new PermanentJobError("TOO_LARGE");
      return new Uint8Array(await readFile(actualPath));
    } catch (error) {
      if (error instanceof PermanentJobError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        throw new PermanentJobError("OBJECT_NOT_FOUND");
      }
      throw new Error(`OBJECT_READ_FAILED: ${key}`);
    }
  }
}
