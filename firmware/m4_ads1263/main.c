/* M4F ADS1263 4-channel differential scan on the MCU header (J9, MCU_SPI0).
 *
 * Same transport as m4_ads8688: frames go to the R5FSS0-0 relay on RPMsg
 * endpoint 40, which forwards them to Linux (ads8688d). Each completed scan
 * of AIN0-1, AIN2-3, AIN4-5, AIN6-7 becomes one 48-byte Ads1263ScanFrame.
 * Control uses the relay's CTL8 packets: START, STOP, SET_RATE (scans/s,
 * 1..300) and GET_STATUS (same value layout as the R5FSS1-0 scan firmware). */
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <kernel/dpl/AddrTranslateP.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/HwiP.h>
#include <kernel/dpl/SystemP.h>
#include <drivers/gpio.h>
#include <drivers/ipc_notify.h>
#include <drivers/ipc_rpmsg.h>
#include "ads1263.h"
#include "ti_drivers_config.h"
#include "ti_drivers_open_close.h"
#include "ti_board_config.h"
#include "ti_board_open_close.h"
#include "../common/ads8688_stream.h"
#include "../common/ads1263_scan_stream.h"

#define IPC_NOTIFY_CLIENT_ID_RP_MBOX     (15U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN      (0x0FFFFF14U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK  (0x0FFFFF15U)

#define DRDY_TIMEOUT_US     (2000U)
#define REPORT_PERIOD_US    (10000000U)
/* All four inputs without DRDY this many scans in a row: pulse RESET and
 * write the configuration again. */
#define DEAD_SCANS_RECOVER  (20U)

static const uint8_t gDiffMux[ADS1263_SCAN_CHANNELS] = {
    ADS1263_MUX_DIFF_0, ADS1263_MUX_DIFF_1, ADS1263_MUX_DIFF_2, ADS1263_MUX_DIFF_3
};

/* What the M4 itself sees, for a JTAG debugger (BLAZAR_Cortex_M4F_0). */
typedef struct {
    uint32_t magic;            /* 'A26M' once initialised */
    uint32_t sequence;
    uint32_t rateHz;
    uint32_t acquiring;
    uint32_t timeouts;
    uint32_t recoveries;
    uint32_t spiErrors;
    uint32_t drdyLevel;
    uint8_t initRegs[7];       /* RREG 00..06 right after (re)configuration */
    uint8_t initVerify[4];     /* MODE0 MODE1 MODE2 INPMUX after the write */
    uint8_t lastTimeoutMask;
    uint8_t lastStatus[4];
    int32_t lastCodes[4];
} Ads1263M4Debug;

volatile Ads1263M4Debug gAds1263Debug;

static RPMessage_Object gR5Endpoint;
static volatile uint8_t gShutdownRequested;
static volatile uint32_t gShutdownRemoteCoreId;
static Ads8688Control gPendingControl;
static volatile uint8_t gControlPending;

static void App_controlCallback(RPMessage_Object *obj, void *args, void *data,
                                uint16_t dataLen, int32_t crcStatus,
                                uint16_t remoteCoreId, uint16_t remoteEndpoint)
{
    const Ads8688Control *control = (const Ads8688Control *)data;

    (void)obj;
    (void)args;
    (void)remoteCoreId;
    (void)remoteEndpoint;
    if ((crcStatus == SystemP_SUCCESS) && (dataLen == sizeof(Ads8688Control)) &&
        Ads8688Control_isValid(control) && (gControlPending == 0U)) {
        memcpy(&gPendingControl, control, sizeof(gPendingControl));
        gControlPending = 1U;
    }
}

static void App_remoteprocCallback(uint32_t remoteCoreId, uint16_t clientId,
                                   uint32_t message, int32_t crcStatus, void *args)
{
    (void)crcStatus;
    (void)args;
    if ((clientId == IPC_NOTIFY_CLIENT_ID_RP_MBOX) &&
        (message == IPC_NOTIFY_RP_MBOX_SHUTDOWN)) {
        gShutdownRemoteCoreId = remoteCoreId;
        gShutdownRequested = 1U;
    }
}

static void App_snapshotInit(const Ads1263InitReport *report)
{
    uint32_t i;

    for (i = 0U; i < 7U; i++) {
        gAds1263Debug.initRegs[i] = report->regs[i];
    }
    for (i = 0U; i < 4U; i++) {
        gAds1263Debug.initVerify[i] = report->verify[i];
    }
    DebugP_log("[ADS1263 M4] regs=[%02X %02X %02X %02X %02X %02X %02X] verify MODE0/1/2/INPMUX=%02X %02X %02X %02X\r\n",
               report->regs[0], report->regs[1], report->regs[2], report->regs[3],
               report->regs[4], report->regs[5], report->regs[6],
               report->verify[0], report->verify[1], report->verify[2], report->verify[3]);
}

/* One scan: select each differential input, wait for DRDY, direct-read ADC1. */
static void App_scan(Ads1263 *device, Ads1263ScanFrame *frame)
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

int main(void)
{
    Ads1263 device;
    Ads1263InitReport report;
    Ads1263ScanFrame frame;
    RPMessage_CreateParams createParams;
    uint32_t rateHz = ADS1263_SCAN_RATE_DEFAULT_HZ;
    uint32_t sequence = 0U, timeouts = 0U, deadScans = 0U, recoveries = 0U;
    uint8_t acquiring = 1U, online;
    uint64_t nextScanUs, nextReportUs, nowUs;
    int32_t status;
    uint32_t i;

    System_init();
    Board_init();
    Drivers_open();
    Board_driversOpen();
    DebugP_log("[ADS1263 M4] MCU_SPI0 scan firmware started\r\n");

    status = RPMessage_waitForLinuxReady(SystemP_WAIT_FOREVER);
    if (status == SystemP_SUCCESS) {
        status = IpcNotify_registerClient(IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                                          App_remoteprocCallback, NULL);
    }
    DebugP_assert(status == SystemP_SUCCESS);
    RPMessage_CreateParams_init(&createParams);
    createParams.localEndPt = ADS8688_M4_R5_ENDPOINT;
    createParams.recvCallback = App_controlCallback;
    status = RPMessage_construct(&gR5Endpoint, &createParams);
    DebugP_assert(status == SystemP_SUCCESS);

    status = Ads1263_init(&device, gMcspiHandle[CONFIG_MCSPI0], gConfigMcspi0ChCfg[0U].chNum,
                          (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_RESET_BASE_ADDR),
                          ADS1263_RESET_PIN,
                          (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_DRDY_BASE_ADDR),
                          ADS1263_DRDY_PIN);
    DebugP_assert(status == SystemP_SUCCESS);
    Ads1263_hardwareReset(&device);
    status = Ads1263_resetAndConfigure(&device, &report);
    online = ((status == SystemP_SUCCESS) && ((report.regs[0] >> 5) == 1U) &&
              (report.verify[2] == 0x8BU)) ? 1U : 0U;
    App_snapshotInit(&report);
    gAds1263Debug.magic = 0x4D363241U; /* 'A26M' */
    DebugP_log("[ADS1263 M4] online=%u rate=%u Hz, frames to R5FSS0-0 endpoint %u\r\n",
               online, rateHz, ADS8688_M4_R5_ENDPOINT);

    IpcNotify_syncAll(SystemP_WAIT_FOREVER);
    nextScanUs = ClockP_getTimeUsec();
    nextReportUs = nextScanUs + REPORT_PERIOD_US;

    while (gShutdownRequested == 0U) {
        if (gControlPending != 0U) {
            Ads8688Control response;
            uintptr_t key = HwiP_disable();
            memcpy(&response, &gPendingControl, sizeof(response));
            gControlPending = 0U;
            HwiP_restore(key);

            response.status = SystemP_SUCCESS;
            switch (response.command) {
                case ADS8688_CONTROL_START:
                    acquiring = 1U;
                    break;
                case ADS8688_CONTROL_STOP:
                    acquiring = 0U;
                    break;
                case ADS8688_CONTROL_SET_RATE:
                    if ((response.value >= ADS1263_SCAN_RATE_MIN_HZ) &&
                        (response.value <= ADS1263_SCAN_RATE_MAX_HZ)) {
                        rateHz = response.value;
                    } else {
                        response.status = SystemP_FAILURE;
                    }
                    break;
                case ADS8688_CONTROL_GET_STATUS:
                    break;
                default:
                    response.status = SystemP_FAILURE;
                    break;
            }
            response.value = (response.command == ADS8688_CONTROL_GET_STATUS)
                             ? (((uint32_t)online << 31) | ((uint32_t)acquiring << 30) |
                                ((recoveries > 0x3FFFU ? 0x3FFFU : recoveries) << 16) | rateHz)
                             : rateHz;
            response.command |= ADS8688_CONTROL_ACK;
            response.crc32 = Ads8688Stream_crc32(&response, offsetof(Ads8688Control, crc32));
            status = RPMessage_send(&response, sizeof(response), CSL_CORE_ID_R5FSS0_0,
                                    ADS8688_M4_R5_ENDPOINT, ADS8688_M4_R5_ENDPOINT,
                                    SystemP_WAIT_FOREVER);
            DebugP_assert(status == SystemP_SUCCESS);
            nextScanUs = ClockP_getTimeUsec();
        }

        nowUs = ClockP_getTimeUsec();
        if (nowUs >= nextReportUs) {
            DebugP_log("[ADS1263 M4] seq=%u rate=%u acquiring=%u timeouts=%u recoveries=%u spiErrors=%u\r\n",
                       sequence, rateHz, acquiring, timeouts, recoveries, device.spiErrors);
            nextReportUs = nowUs + REPORT_PERIOD_US;
        }
        if (acquiring == 0U) {
            ClockP_usleep(1000U);
            continue;
        }
        if (nowUs < nextScanUs) {
            ClockP_usleep((uint32_t)(nextScanUs - nowUs));
            continue;
        }
        nextScanUs += 1000000U / rateHz;
        if (nextScanUs < nowUs) {
            nextScanUs = nowUs + 1000000U / rateHz;
        }

        memset(&frame, 0, sizeof(frame));
        frame.magic = ADS1263_SCAN_MAGIC;
        frame.version = ADS1263_SCAN_VERSION;
        frame.channelCount = ADS1263_SCAN_CHANNELS;
        frame.sequence = sequence++;
        frame.scanRateHz = rateHz;
        App_scan(&device, &frame);
        frame.crc32 = Ads1263_crc32(&frame, offsetof(Ads1263ScanFrame, crc32));
        status = RPMessage_send(&frame, sizeof(frame), CSL_CORE_ID_R5FSS0_0,
                                ADS8688_M4_R5_ENDPOINT, ADS8688_M4_R5_ENDPOINT,
                                SystemP_WAIT_FOREVER);
        DebugP_assert(status == SystemP_SUCCESS);

        if (frame.timeoutMask != 0U) {
            timeouts++;
        }
        deadScans = (frame.timeoutMask == 0x0FU) ? deadScans + 1U : 0U;
        if (deadScans >= DEAD_SCANS_RECOVER) {
            Ads1263_hardwareReset(&device);
            status = Ads1263_resetAndConfigure(&device, &report);
            online = ((status == SystemP_SUCCESS) && ((report.regs[0] >> 5) == 1U) &&
                      (report.verify[2] == 0x8BU)) ? 1U : 0U;
            recoveries++;
            deadScans = 0U;
            App_snapshotInit(&report);
        }

        for (i = 0U; i < ADS1263_SCAN_CHANNELS; i++) {
            gAds1263Debug.lastStatus[i] = frame.status[i];
            gAds1263Debug.lastCodes[i] = frame.codes[i];
        }
        gAds1263Debug.lastTimeoutMask = frame.timeoutMask;
        gAds1263Debug.drdyLevel = GPIO_pinRead(device.drdyGpioBase, device.drdyGpioPin);
        gAds1263Debug.sequence = frame.sequence;
        gAds1263Debug.rateHz = rateHz;
        gAds1263Debug.acquiring = acquiring;
        gAds1263Debug.timeouts = timeouts;
        gAds1263Debug.recoveries = recoveries;
        gAds1263Debug.spiErrors = device.spiErrors;
    }

    RPMessage_destruct(&gR5Endpoint);
    Board_driversClose();
    Drivers_close();
    IpcNotify_sendMsg(gShutdownRemoteCoreId, IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                      IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK, 1U);
    for (;;) {
        __asm__ __volatile__("wfi" : : : "memory");
    }
    return 0;
}
