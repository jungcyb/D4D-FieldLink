import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Mode, Store } from "../types.ts";
import { emptyStore, makeDemoStore } from "./seed.ts";

/** next dev uses seeded mock devices; next start uses the isolated real-device store. */
export function configuredMode(environment: {DAQ_MODE?: string; NODE_ENV?: string} = process.env): Mode {
  if (environment.DAQ_MODE === "demo" || environment.DAQ_MODE === "external") return environment.DAQ_MODE;
  return environment.NODE_ENV === "development" ? "demo" : "external";
}
export function dataDirectory(): string { return resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || "data"); }
/** Single-process local PMVP repository. All read-modify-write operations are synchronous.
 * Replace this module with a transactional DB repository for multi-instance deployment. */
export class FileRepository {
  directory: string; mode: Mode; filename: string;
  constructor(directory = dataDirectory(), mode = configuredMode()) {
    this.directory = directory; this.mode = mode; this.filename = join(directory, `${mode}.json`);
  }
  read(): Store {
    mkdirSync(this.directory, { recursive: true });
    if (!existsSync(this.filename)) this.write(this.mode === "demo" ? makeDemoStore() : emptyStore(this.mode));
    const store = JSON.parse(readFileSync(this.filename, "utf8")) as Store;
    if (store.version !== 1 || store.mode !== this.mode) throw new Error("지원하지 않는 데이터 저장 형식입니다.");
    for (const sensor of store.sensors) sensor.calibration ||= { scale: 1, offset: 0, inputUnit: store.mode === "demo" ? sensor.unit : "V", updatedAt: null };
    return store;
  }
  write(store: Store): void {
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(store), "utf8");
    renameSync(temporary, this.filename);
  }
  mutate<T>(fn: (store: Store) => T): T {
    const store = this.read();
    const result = fn(store);
    this.write(store);
    return result;
  }
}
