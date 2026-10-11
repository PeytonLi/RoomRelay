import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./env";

export interface ObjectStore {
  readonly backend: "LOCAL_FS";
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<{ bytes: number } | null>;
}

export class LocalFsObjectStore implements ObjectStore {
  readonly backend = "LOCAL_FS" as const;
  private readonly root: string;

  constructor(root = defaultObjectStoreRoot()) {
    this.root = path.resolve(root);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = this.resolveKey(key);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    const target = this.resolveKey(key);
    try {
      return { bytes: (await stat(target)).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private resolveKey(key: string): string {
    const segments = key.split("/");
    if (
      !key ||
      key.includes("\\") ||
      key.includes("\0") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("invalid object key");
    }
    const target = path.resolve(this.root, ...segments);
    const relative = path.relative(this.root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("invalid object key");
    }
    return target;
  }
}

export type ObjectStoreSelection =
  | { available: true; store: ObjectStore }
  | { available: false; backend: "S3"; reason: string };

const S3_VARIABLES = [
  "OBJECT_STORE_ENDPOINT",
  "OBJECT_STORE_REGION",
  "OBJECT_STORE_BUCKET",
  "OBJECT_STORE_ACCESS_KEY_ID",
  "OBJECT_STORE_SECRET_ACCESS_KEY",
] as const;

function defaultObjectStoreRoot(): string {
  const cwd = process.cwd();
  const isWebWorkspace = path.basename(cwd) === "web" && path.basename(path.dirname(cwd)) === "apps";
  return path.resolve(cwd, isWebWorkspace ? "../../runtime-assets/object-store" : "runtime-assets/object-store");
}

export function getObjectStore(): ObjectStoreSelection {
  const { env, capabilities } = getConfig();
  const anyConfigured = S3_VARIABLES.some((name) => Boolean(env[name]?.trim()));
  if (!anyConfigured) {
    return {
      available: true,
      store: new LocalFsObjectStore(env.OBJECT_STORE_LOCAL_DIR || defaultObjectStoreRoot()),
    };
  }
  if (capabilities.objectStore.status !== "available") {
    return { available: false, backend: "S3", reason: "S3 configuration incomplete" };
  }
  return { available: false, backend: "S3", reason: "S3 adapter not implemented" };
}

export function getObjectStoreStatus(): {
  status: "available" | "unavailable";
  backend: "LOCAL_FS" | "S3";
  reason?: string;
} {
  const selection = getObjectStore();
  return selection.available
    ? { status: "available", backend: selection.store.backend }
    : { status: "unavailable", backend: selection.backend, reason: selection.reason };
}
