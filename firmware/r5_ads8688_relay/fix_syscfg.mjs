import { readFileSync, writeFileSync } from "node:fs";

const driverPath = "generated/ti_drivers_config.c";
let driver = readFileSync(driverPath, "utf8");
driver = driver.replace(
  /#define IPC_SHARED_MEM_SIZE\s+\(0U\)/,
  "#define IPC_SHARED_MEM_SIZE               (2624U)",
).replace(
  /\/\* TX VRINGs \*\/[\s\S]*?\/\* Other VRING properties \*\//,
  `/* TX VRINGs */
        rpmsgParams.vringTxBaseAddr[CSL_CORE_ID_M4FSS0_0] = (uintptr_t)(&gIpcSharedMem[0]);
        /* RX VRINGs */
        rpmsgParams.vringRxBaseAddr[CSL_CORE_ID_M4FSS0_0] = (uintptr_t)(&gIpcSharedMem[1312]);
        /* Other VRING properties */`,
);
if (!driver.includes("gIpcSharedMem[1312]") ||
    !driver.includes("IPC_SHARED_MEM_SIZE               (2624U)")) {
  throw new Error("SysConfig IPC patch no longer matches generated output");
}
writeFileSync(driverPath, driver);
