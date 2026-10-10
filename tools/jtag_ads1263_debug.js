// Read the ADS1263 scan firmware's own view over JTAG (XDS110), bypassing
// RPMsg and ads8688d. Attaches to MAIN_Cortex_R5_1_0 (R5FSS1-0) only, loads
// symbols (never the program) and takes two snapshots of gAds1263Debug and
// MCSPI1. The R5 debug port cannot read memory while the core runs, so each
// snapshot halts the core briefly and resumes it. No reset, no GEL init.
//
//   C:\ti\ccs2100\ccs\scripting\run.bat tools\jtag_ads1263_debug.js
const { join } = require("path");

const root = join(__dirname, "..");
const ccxml = join(root, "firmware/r5_ads1263/targetConfigs/AM64x_ADS1263_attach.ccxml");
const symbols = join(root, "firmware/r5_ads1263_scan/ti-arm-clang/r5_ads1263_scan.debug.out");

const ds = initScripting();
ds.setScriptingTimeout(120000);
ds.configure(ccxml);
const session = ds.openSession(/MAIN_Cortex_R5_1_0$/);
session.target.connect();
const haltedOnConnect = session.target.isHalted();
session.symbols.load(symbols);

const hex = (v, w = 2) => "0x" + Number(v).toString(16).toUpperCase().padStart(w, "0");
const bytes = (expr, n) =>
  Array.from({ length: n }, (_, i) => hex(session.expressions.evaluate(`${expr}[${i}]`))).join(" ");
const field = (name) => Number(session.expressions.evaluate(`gAds1263Debug.${name}`));

function snapshot(label) {
  if (!session.target.isHalted()) {
    session.target.halt();
  }
  try {
    print(label);
  } finally {
    session.target.run(false);
  }
}

function print(label) {
  const base = 0x20110000;
  const reg = (offset) => hex(session.memory.readOne(base + offset, 32), 8);
  console.log(`--- ${label}`);
  console.log(`magic=${hex(field("magic"), 8)} updates=${field("updates")} sequence=${field("sequence")} ` +
              `rate=${field("rateHz")}Hz acquiring=${field("acquiring")} linuxReady=${field("linuxReady")}`);
  console.log(`timeouts=${field("timeouts")} recoveries=${field("recoveries")} spiErrors=${field("spiErrors")} ` +
              `sendErrors=${field("sendErrors")} lastTimeoutMask=${hex(field("lastTimeoutMask"))}`);
  console.log(`DRDY level=${field("drdyLevel")} RESET out=${field("resetLevel")}`);
  console.log(`init RREG 00..06 = ${bytes("gAds1263Debug.initRegs", 7)}   verify MODE0/1/2/INPMUX = ${bytes("gAds1263Debug.initVerify", 4)}`);
  console.log(`per-scan RREG ID tx = ${bytes("gAds1263Debug.probeTx", 3)}   rx = ${bytes("gAds1263Debug.probeRx", 3)}`);
  console.log(`last status = ${bytes("gAds1263Debug.lastStatus", 4)}   codes = ` +
              [0, 1, 2, 3].map((i) => Number(session.expressions.evaluate(`gAds1263Debug.lastCodes[${i}]`))).join(", "));
  console.log(`MCSPI1 (debugger bus read) MODULCTRL=${reg(0x128)} CH0CONF=${reg(0x12C)} CH0STAT=${reg(0x130)} ` +
              `| firmware copy CH0CONF=${hex(field("mcspiCh0Conf"), 8)}`);
}

try {
  snapshot("read 1");
  const start = Date.now();
  while (Date.now() - start < 1000) { /* let the core run ~1 s */ }
  snapshot("read 2 (1 s later)");
} finally {
  if (session.target.isHalted()) {
    session.target.run(false);
  }
  console.log(`core halted on connect: ${haltedOnConnect}; left running: ${!session.target.isHalted()}`);
  session.target.disconnect();
  ds.shutdown();
}
