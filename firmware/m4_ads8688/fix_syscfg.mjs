import { readFileSync, writeFileSync } from "node:fs";

const driverPath = "generated/ti_drivers_config.c";
let driver = readFileSync(driverPath, "utf8");
driver = driver.replace(
  /#define IPC_SHARED_MEM_SIZE\s+\(0U\)/,
  "#define IPC_SHARED_MEM_SIZE               (2624U)",
).replace(
  /\/\* TX VRINGs \*\/[\s\S]*?\/\* Other VRING properties \*\//,
  `/* TX VRINGs */
        rpmsgParams.vringTxBaseAddr[CSL_CORE_ID_R5FSS0_0] = (uintptr_t)(&gIpcSharedMem[1312]);
        /* RX VRINGs */
        rpmsgParams.vringRxBaseAddr[CSL_CORE_ID_R5FSS0_0] = (uintptr_t)(&gIpcSharedMem[0]);
        /* Other VRING properties */`,
);
if (!driver.includes("gIpcSharedMem[1312]") || !driver.includes("IPC_SHARED_MEM_SIZE               (2624U)")) {
  throw new Error("SysConfig IPC patch no longer matches generated output");
}
writeFileSync(driverPath, driver);

const linkerPath = "generated/linker.cmd";
let linker = readFileSync(linkerPath, "utf8");
const marker = "    /* For memory Regions not defined in this core but shared by other cores with the current core */";
if (!linker.includes("IPC_VRING_MEM   : ORIGIN")) {
  linker = linker.replace(marker, `${marker}

    USER_SHM_MEM   : ORIGIN = 0xA5000000 , LENGTH = 0x80
    LOG_SHM_MEM    : ORIGIN = 0xA5000080 , LENGTH = 0x3F80
    IPC_VRING_MEM  : ORIGIN = 0x701D4000 , LENGTH = 0xC000`);
}
if (!linker.includes("IPC_VRING_MEM  : ORIGIN = 0x701D4000")) {
  throw new Error("SysConfig linker patch no longer matches generated output");
}
writeFileSync(linkerPath, linker);
