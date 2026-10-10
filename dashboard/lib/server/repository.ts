import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Mode, Store } from "../types.ts";
import { emptyStore, makeDemoStore } from "./seed.ts";

type BufferedStore={store:Store;timer:ReturnType<typeof setTimeout>|null;dirty:boolean};
const bufferedStores=new Map<string,BufferedStore>();
function writeDelay():number{const value=Number(process.env.FILE_REPOSITORY_WRITE_DEBOUNCE_MS||0);return Number.isFinite(value)&&value>=0&&value<=5000?value:0;}

/** next dev uses seeded mock devices; next start uses the isolated real-device store. */
export function configuredMode(environment: {DAQ_MODE?: string; NODE_ENV?: string} = process.env): Mode {
  if (environment.DAQ_MODE === "demo" || environment.DAQ_MODE === "external") return environment.DAQ_MODE;
  return environment.NODE_ENV === "development" ? "demo" : "external";
}
export function dataDirectory(): string { return resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || "data"); }
/** Single-process local PMVP repository. Production may coalesce disk flushes while
 * reads and mutations use the latest in-memory snapshot. Replace this module with
 * a transactional DB repository for multi-instance deployment. */
export class FileRepository {
  directory: string; mode: Mode; filename: string;
  constructor(directory = dataDirectory(), mode = configuredMode()) {
    this.directory = directory; this.mode = mode; this.filename = join(directory, `${mode}.json`);
  }
  read(): Store {
    mkdirSync(this.directory, { recursive: true });
    const buffered=bufferedStores.get(this.filename);if(buffered)return buffered.store;
    if (!existsSync(this.filename)) {const initial=this.mode === "demo" ? makeDemoStore() : emptyStore(this.mode);this.write(initial);return initial;}
    const store = JSON.parse(readFileSync(this.filename, "utf8")) as Store;
    if (store.version !== 1 || store.mode !== this.mode) throw new Error("지원하지 않는 데이터 저장 형식입니다.");
    for (const sensor of store.sensors) sensor.calibration ||= { scale: 1, offset: 0, inputUnit: store.mode === "demo" ? sensor.unit : "V", updatedAt: null };
    if(writeDelay())bufferedStores.set(this.filename,{store,timer:null,dirty:false});
    return store;
  }
  write(store: Store): void {
    const delay=writeDelay();
    if(delay){
      const entry=bufferedStores.get(this.filename)||{store,timer:null,dirty:false};entry.store=store;entry.dirty=true;bufferedStores.set(this.filename,entry);
      const schedule=()=>{entry.timer=setTimeout(()=>{entry.timer=null;if(!entry.dirty)return;entry.dirty=false;try{this.writeNow(entry.store);}catch(error){entry.dirty=true;console.error("Repository flush failed:",error);schedule();}},delay);entry.timer.unref();};
      if(!entry.timer)schedule();return;
    }
    this.writeNow(store);
  }
  private writeNow(store: Store): void {
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(store), "utf8");
    // Replacing an existing file with rename is repeatedly delayed by Windows
    // readers (antivirus/indexing and concurrent dashboard GETs). The complete
    // temp file remains the source until overwrite succeeds.
    if (process.platform === "win32") {
      copyFileSync(temporary, this.filename);
      unlinkSync(temporary);
      return;
    }
    // Keep the atomic replacement elsewhere and tolerate transient filesystem locks.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, this.filename); break; }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (!["EPERM", "EACCES", "EBUSY"].includes(code) || attempt === 6) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 2 ** attempt);
      }
    }
  }
  mutate<T>(fn: (store: Store) => T): T {
    const store = this.read();
    const result = fn(store);
    this.write(store);
    return result;
  }
}
