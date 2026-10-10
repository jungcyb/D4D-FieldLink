/* R5FSS1-0 ADS1263 4-channel differential scan, streamed to Linux over RPMsg.
 *
 * Linux (ads8688d) opens the rpmsg_chrdev endpoint and writes once to
 * subscribe; every completed scan is then sent as one Ads1263ScanFrame.
 * CTL6 control packets start/stop acquisition and set the scan rate.
 * The ADS1263 driver (ads1263.c) is shared with the CCS bring-up project. */
#include <stdint.h>
#include <string.h>

#include <drivers/gpio.h>
#include <drivers/ipc_rpmsg.h>
#include <kernel/dpl/AddrTranslateP.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/HwiP.h>
#include <kernel/dpl/SystemP.h>

#include "ads1263.h"
#include "ti_drivers_config.h"
#include "ti_drivers_open_close.h"
#include "ti_board_open_close.h"
#include "../common/ads1263_scan_stream.h"

#define DRDY_TIMEOUT_US     (2000U)
#define REPORT_PERIOD_US    (10000000U)
/* All four inputs silent this many scans in a row: the ADS1263 lost its
 * configuration (seen once at service start-up, MODE1/MODE2 back at reset
 * defaults), so write the registers and START1 again. */
#define DEAD_SCANS_RECOVER  (20U)

static const uint8_t gDiffMux[ADS1263_SCAN_CHANNELS] = {
    ADS1263_MUX_DIFF_0, ADS1263_MUX_DIFF_1, ADS1263_MUX_DIFF_2, ADS1263_MUX_DIFF_3
};

/* Snapshot of what the firmware itself sees, for a JTAG debugger (read with
 * the core running; no halt needed). Independent of RPMsg/ads8688d. */
typedef struct {
    uint32_t magic;            /* 'A26D' once initialised */
    uint32_t updates;          /* increments on every scan */
    uint32_t sequence;
    uint32_t rateHz;
    uint32_t acquiring;
    uint32_t linuxReady;
    uint32_t timeouts;
    uint32_t recoveries;
    uint32_t spiErrors;
    uint32_t sendErrors;
    uint32_t drdyLevel;        /* GPIO read right after the last scan */
    uint32_t resetLevel;
    uint32_t mcspiCh0Conf;
    uint32_t mcspiModulCtrl;
    uint8_t initRegs[7];       /* RREG 00..06 right after (re)configuration */
    uint8_t initVerify[4];     /* MODE0 MODE1 MODE2 INPMUX after the write */
    uint8_t probeTx[3];        /* RREG ID done every scan: 20 00 00 */
    uint8_t probeRx[3];        /* rx[2] must be the chip ID (0x2x) */
    uint8_t lastTimeoutMask;
    uint8_t lastStatus[4];
    int32_t lastCodes[4];
} Ads1263Debug;

volatile Ads1263Debug gAds1263Debug;

static RPMessage_Object gLinuxEndpoint;
static volatile uint8_t gLinuxReady;
static volatile uint16_t gLinuxCoreId;
static volatile uint16_t gLinuxRemoteEndpoint;
static volatile uint8_t gControlPending;
static volatile uint8_t gHelloPending;
static Ads1263Control gPendingControl;

static void scan_linuxCallback(RPMessage_Object *obj, void *args, void *data,
                               uint16_t dataLen, int32_t crcStatus,
                               uint16_t remoteCoreId, uint16_t remoteEndpoint)
{
    const Ads1263Control *control = (const Ads1263Control *)data;

    (void)obj;
    (void)args;
    gLinuxCoreId = remoteCoreId;
    gLinuxRemoteEndpoint = remoteEndpoint;
    gLinuxReady = 1U;
    if ((crcStatus == SystemP_SUCCESS) && (dataLen == sizeof(*control)) &&
        Ads1263Control_isValid(control) && (gControlPending == 0U)) {
        memcpy(&gPendingControl, control, sizeof(gPendingControl));
        gControlPending = 1U;
    } else {
        gHelloPending = 1U;
    }
}

static int32_t scan_send(const void *data, uint16_t size, uint32_t timeout)
{
    if (gLinuxReady == 0U) {
        return SystemP_FAILURE;
    }
    return RPMessage_send((void *)data, size, gLinuxCoreId, gLinuxRemoteEndpoint,
                          ADS1263_LINUX_ENDPOINT, timeout);
}

/* One scan: select each differential input, wait for DRDY, direct-read ADC1. */
static void scan_once(Ads1263 *device, Ads1263ScanFrame *frame)
{
    Ads1263Sample sample;
    uint32_t ch;

    frame->timestampUs = ClockP_getTimeUsec();
    for (ch = 0U; ch < ADS1263_SCAN_CHANNELS; ch++) {
        frame->status[ch] = 0U;
        frame->codes[ch] = 0;
        if ((Ads1263_selectInput(device, gDiffMux[ch]) != SystemP_SUCCESS) ||
            (Ads1263_waitDrdy(device, DRDY_TIMEOUT_US) != SystemP_SUCCESS) ||
            (Ads1263_readAdc1(device, &sample) != SystemP_SUCCESS)) {
            frame->timeoutMask |= (uint8_t)(1U << ch);
            continue;
        }
        frame->status[ch] = sample.status;
        frame->codes[ch] = sample.code;
    }
}

void scan_app_main(void *args)
{
    RPMessage_CreateParams createParams;
    Ads1263 device;
    Ads1263InitReport report;
    Ads1263ScanFrame frame;
    uint32_t rateHz = ADS1263_SCAN_RATE_DEFAULT_HZ;
    uint8_t acquiring = 1U, online;
    uint32_t sequence = 0U, sendErrors = 0U, timeouts = 0U;
    uint32_t deadScans = 0U, recoveries = 0U;
    uint64_t nextScan, nextReport;
    int32_t status;

    (void)args;
    Drivers_open();
    Board_driversOpen();

    status = RPMessage_waitForLinuxReady(SystemP_WAIT_FOREVER);
    DebugP_assert(status == SystemP_SUCCESS);
    RPMessage_CreateParams_init(&createParams);
    createParams.localEndPt = ADS1263_LINUX_ENDPOINT;
    createParams.recvCallback = scan_linuxCallback;
    status = RPMessage_construct(&gLinuxEndpoint, &createParams);
    DebugP_assert(status == SystemP_SUCCESS);
    status = RPMessage_announce(CSL_CORE_ID_A53SS0_0, ADS1263_LINUX_ENDPOINT,
                                ADS1263_LINUX_SERVICE);
    DebugP_assert(status == SystemP_SUCCESS);

    status = Ads1263_init(&device, gMcspiHandle[CONFIG_ADS1263_MCSPI],
                          gConfigAds1263McspiChCfg[0U].chNum,
                          (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_RESET_BASE_ADDR),
                          ADS1263_RESET_PIN,
                          (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_DRDY_BASE_ADDR),
                          ADS1263_DRDY_PIN);
    if (status == SystemP_SUCCESS) {
        status = Ads1263_resetAndConfigure(&device, &report);
    }
    online = ((status == SystemP_SUCCESS) && ((report.regs[0] >> 5) == 1U) &&
              (report.verify[2] == 0x8BU)) ? 1U : 0U;
    DebugP_log("ADS1263: regs=[%02X %02X %02X %02X %02X %02X %02X]\n",
               report.regs[0], report.regs[1], report.regs[2], report.regs[3],
               report.regs[4], report.regs[5], report.regs[6]);
    DebugP_log("ADS1263: verify MODE0=%02X MODE1=%02X MODE2=%02X INPMUX=%02X (expect 00 00 8B 0A)\n",
               report.verify[0], report.verify[1], report.verify[2], report.verify[3]);
    DebugP_log("ADS1263: online=%u rate=%u Hz, streaming over RPMsg endpoint %u\n",
               online, rateHz, ADS1263_LINUX_ENDPOINT);

    nextScan = ClockP_getTimeUsec();
    nextReport = nextScan + REPORT_PERIOD_US;
    gAds1263Debug.magic = 0x44363241U; /* 'A26D' */
    {
        uint32_t i;
        for (i = 0U; i < 7U; i++) { gAds1263Debug.initRegs[i] = report.regs[i]; }
        for (i = 0U; i < 4U; i++) { gAds1263Debug.initVerify[i] = report.verify[i]; }
    }
    for (;;) {
        uint64_t now;

        if (gHelloPending != 0U) {
            gHelloPending = 0U;
            (void)scan_send(ADS1263_SCAN_HELLO_REPLY, sizeof(ADS1263_SCAN_HELLO_REPLY) - 1U,
                            SystemP_WAIT_FOREVER);
        }
        if (gControlPending != 0U) {
            Ads1263Control response;
            uintptr_t key = HwiP_disable();
            memcpy(&response, &gPendingControl, sizeof(response));
            gControlPending = 0U;
            HwiP_restore(key);

            response.status = SystemP_SUCCESS;
            switch (response.command) {
                case ADS1263_CONTROL_GET_STATUS:
                    break;
                case ADS1263_CONTROL_START:
                    acquiring = online;
                    response.status = online ? SystemP_SUCCESS : SystemP_FAILURE;
                    nextScan = ClockP_getTimeUsec();
                    break;
                case ADS1263_CONTROL_STOP:
                    acquiring = 0U;
                    break;
                case ADS1263_CONTROL_SET_RATE:
                    if ((response.value >= ADS1263_SCAN_RATE_MIN_HZ) &&
                        (response.value <= ADS1263_SCAN_RATE_MAX_HZ)) {
                        rateHz = response.value;
                        nextScan = ClockP_getTimeUsec();
                    } else {
                        response.status = SystemP_FAILURE;
                    }
                    break;
                default:
                    response.status = SystemP_FAILURE;
                    break;
            }
            response.command |= ADS1263_CONTROL_ACK;
            response.value = (response.command == (ADS1263_CONTROL_GET_STATUS | ADS1263_CONTROL_ACK))
                             ? (((uint32_t)online << 31) | ((uint32_t)acquiring << 30) |
                                ((recoveries > 0x3FFFU ? 0x3FFFU : recoveries) << 16) | rateHz)
                             : rateHz;
            response.crc32 = Ads1263_crc32(&response, offsetof(Ads1263Control, crc32));
            (void)scan_send(&response, sizeof(response), SystemP_WAIT_FOREVER);
        }

        now = ClockP_getTimeUsec();
        if (now >= nextReport) {
            DebugP_log("ADS1263: seq=%u rate=%u acquiring=%u sendErrors=%u timeouts=%u recoveries=%u spiErrors=%u\n",
                       sequence, rateHz, acquiring, sendErrors, timeouts, recoveries, device.spiErrors);
            nextReport = now + REPORT_PERIOD_US;
        }
        if ((acquiring == 0U) || (gLinuxReady == 0U)) {
            ClockP_usleep(1000U);
            continue;
        }
        if (now < nextScan) {
            ClockP_usleep((uint32_t)(nextScan - now));
            continue;
        }
        /* Keep the cadence; if a scan overran its slot, restart from now. */
        nextScan += 1000000U / rateHz;
        if (nextScan < now) {
            nextScan = now + 1000000U / rateHz;
        }

        memset(&frame, 0, sizeof(frame));
        frame.magic = ADS1263_SCAN_MAGIC;
        frame.version = ADS1263_SCAN_VERSION;
        frame.channelCount = ADS1263_SCAN_CHANNELS;
        frame.sequence = sequence++;
        frame.scanRateHz = rateHz;
        scan_once(&device, &frame);
        {
            uint32_t base = MCSPI_getBaseAddr(device.spiHandle);
            uint32_t i;
            uint8_t tx[3] = {ADS1263_CMD_RREG | ADS1263_REG_ID, 0x00U, 0x00U};
            uint8_t rx[3] = {0};
            (void)Ads1263_transaction(&device, tx, rx, 3U);
            for (i = 0U; i < 3U; i++) {
                gAds1263Debug.probeTx[i] = tx[i];
                gAds1263Debug.probeRx[i] = rx[i];
            }
            for (i = 0U; i < ADS1263_SCAN_CHANNELS; i++) {
                gAds1263Debug.lastStatus[i] = frame.status[i];
                gAds1263Debug.lastCodes[i] = frame.codes[i];
            }
            gAds1263Debug.lastTimeoutMask = frame.timeoutMask;
            gAds1263Debug.drdyLevel = GPIO_pinRead(device.drdyGpioBase, device.drdyGpioPin);
            gAds1263Debug.resetLevel = GPIO_pinOutValueRead(device.resetGpioBase, device.resetGpioPin);
            gAds1263Debug.mcspiCh0Conf = *(volatile uint32_t *)(base + 0x12CU);
            gAds1263Debug.mcspiModulCtrl = *(volatile uint32_t *)(base + 0x128U);
            gAds1263Debug.sequence = frame.sequence;
            gAds1263Debug.rateHz = rateHz;
            gAds1263Debug.acquiring = acquiring;
            gAds1263Debug.linuxReady = gLinuxReady;
            gAds1263Debug.timeouts = timeouts;
            gAds1263Debug.recoveries = recoveries;
            gAds1263Debug.spiErrors = device.spiErrors;
            gAds1263Debug.sendErrors = sendErrors;
            gAds1263Debug.updates++;
        }
        if (frame.timeoutMask != 0U) {
            timeouts++;
        }
        deadScans = (frame.timeoutMask == 0x0FU) ? deadScans + 1U : 0U;
        if (deadScans >= DEAD_SCANS_RECOVER) {
            status = Ads1263_resetAndConfigure(&device, &report);
            recoveries++;
            deadScans = 0U;
            {
                uint32_t i;
                for (i = 0U; i < 7U; i++) { gAds1263Debug.initRegs[i] = report.regs[i]; }
                for (i = 0U; i < 4U; i++) { gAds1263Debug.initVerify[i] = report.verify[i]; }
            }
            DebugP_log("ADS1263: no DRDY for %u scans, reconfigured (#%u): regs=[%02X %02X %02X %02X %02X %02X %02X] verify MODE2=%02X\n",
                       DEAD_SCANS_RECOVER, recoveries, report.regs[0], report.regs[1], report.regs[2],
                       report.regs[3], report.regs[4], report.regs[5], report.regs[6], report.verify[2]);
        }
        frame.crc32 = Ads1263_crc32(&frame, offsetof(Ads1263ScanFrame, crc32));
        /* Never block acquisition on a slow Linux reader; count the drop. */
        if (scan_send(&frame, sizeof(frame), SystemP_NO_WAIT) != SystemP_SUCCESS) {
            sendErrors++;
        }
    }
}
