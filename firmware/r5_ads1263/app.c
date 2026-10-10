#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <drivers/gpio.h>
#include <drivers/ipc_notify.h>
#include <drivers/ipc_rpmsg.h>
#include <drivers/sciclient.h>
#include <kernel/dpl/AddrTranslateP.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/HwiP.h>
#include <kernel/dpl/SystemP.h>
#include <kernel/dpl/TimerP.h>

#include "ads1263.h"
#include "ti_drivers_config.h"
#include "ti_drivers_open_close.h"
#include "ti_board_open_close.h"
#include "../common/ads1263_stream.h"

#define IPC_NOTIFY_CLIENT_ID_RP_MBOX     (15U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN      (0x0FFFFF14U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK  (0x0FFFFF15U)
#define ADS1263_POLL_INTERVAL_US          (100U)

static RPMessage_Object gLinuxEndpoint;
static volatile uint8_t gShutdownRequested;
static volatile uint32_t gShutdownRemoteCoreId;
extern ClockP_Config gClockConfig;
static volatile uint8_t gLinuxReady;
static volatile uint8_t gStatusRequested;
static volatile uint8_t gControlPending;
static volatile uint16_t gLinuxCoreId;
static volatile uint16_t gLinuxRemoteEndpoint;
static Ads1263Control gPendingControl;

/* Never borrow Linux/another core's DMA resources. Query this R5 host only;
 * unlike the generic SDK allocator, do not fall back to HOST_ID_ALL. */
static uint8_t App_dmaResourcesOwned(void)
{
    static const uint16_t types[] = {
        TISCI_DEV_DMASS0_PKTDMA_0, TISCI_DEV_DMASS0_PKTDMA_0,
        TISCI_DEV_DMASS0_INTAGGR_0, TISCI_DEV_DMASS0_INTAGGR_0
    };
    static const uint8_t subtypes[] = {
        TISCI_RESASG_SUBTYPE_PKTDMA_UNMAPPED_TX_CHAN,
        TISCI_RESASG_SUBTYPE_PKTDMA_UNMAPPED_RX_CHAN,
        TISCI_RESASG_SUBTYPE_GLOBAL_EVENT_SEVT, TISCI_RESASG_SUBTYPE_IA_VINT
    };
    uint8_t owned = 1U;
    uint32_t i;
    for (i = 0U; i < 4U; i++)
    {
        struct tisci_msg_rm_get_resource_range_req req = {0};
        struct tisci_msg_rm_get_resource_range_resp res = {0};
        int32_t status;
        req.type = types[i];
        req.subtype = subtypes[i];
        req.secondary_host = TISCI_MSG_VALUE_RM_UNUSED_SECONDARY_HOST;
        status = Sciclient_rmGetResourceRange(&req, &res, 100000U);
        DebugP_log("[ADS1263] DMA own-host type=%u subtype=%u status=%d range=%u+%u secondary=%u+%u\r\n",
                   req.type, req.subtype, status, res.range_start, res.range_num,
                   res.range_start_sec, res.range_num_sec);
        if ((status != SystemP_SUCCESS) ||
            ((res.range_num + res.range_num_sec) == 0U)) owned = 0U;
    }
    return owned;
}

static void App_remoteprocCallback(uint32_t remoteCoreId,
                                   uint16_t clientId,
                                   uint32_t message,
                                   int32_t crcStatus,
                                   void *args)
{
    (void)crcStatus;
    (void)args;
    if ((clientId == IPC_NOTIFY_CLIENT_ID_RP_MBOX) &&
        (message == IPC_NOTIFY_RP_MBOX_SHUTDOWN))
    {
        gShutdownRemoteCoreId = remoteCoreId;
        gShutdownRequested = 1U;
    }
}

static void App_linuxCallback(RPMessage_Object *obj,
                              void *args,
                              void *data,
                              uint16_t dataLen,
                              int32_t crcStatus,
                              uint16_t remoteCoreId,
                              uint16_t remoteEndpoint)
{
    const Ads1263Control *control = (const Ads1263Control *)data;

    (void)obj;
    (void)args;
    gLinuxCoreId = remoteCoreId;
    gLinuxRemoteEndpoint = remoteEndpoint;
    gLinuxReady = 1U;
    if ((crcStatus == SystemP_SUCCESS) &&
        (dataLen == sizeof(*control)) &&
        Ads1263Control_isValid(control) &&
        (gControlPending == 0U))
    {
        memcpy(&gPendingControl, control, sizeof(gPendingControl));
        gControlPending = 1U;
    }
    else
    {
        gStatusRequested = 1U;
    }
}

static uint32_t App_flags(uint8_t online, uint8_t acquiring)
{
    return (online != 0U ? ADS1263_FLAG_DEVICE_ONLINE : 0U) |
           (acquiring != 0U ? ADS1263_FLAG_ACQUIRING : 0U);
}

static void App_fillFrame(Ads1263StreamFrame *frame,
                          Ads1263 *device,
                          uint8_t type,
                          uint8_t adcStatus,
                          uint32_t sequence,
                          int32_t pressure,
                          int32_t thermocouple,
                          uint32_t flags,
                          uint32_t ioErrors)
{
    memset(frame, 0, sizeof(*frame));
    frame->magic = ADS1263_STREAM_MAGIC;
    frame->version = ADS1263_STREAM_VERSION;
    frame->frameType = type;
    frame->adcStatus = adcStatus;
    frame->sequence = sequence;
    frame->timestampUs = ClockP_getTimeUsec();
    frame->pressureCode = pressure;
    frame->thermocoupleCode = thermocouple;
    frame->flags = flags;
    frame->pressureSps = ADS1263_PRESSURE_SPS;
    frame->thermocoupleSps = ADS1263_THERMOCOUPLE_SPS;
    frame->crcErrors = device->crcErrors;
    frame->ioErrors = device->spiErrors + ioErrors;
    frame->crc32 = Ads1263_crc32(frame, offsetof(Ads1263StreamFrame, crc32));
}

static int32_t App_send(const void *data, uint16_t size, uint32_t timeout)
{
    if (gLinuxReady == 0U)
    {
        return SystemP_SUCCESS;
    }
    return RPMessage_send((void *)data, size, gLinuxCoreId,
                          gLinuxRemoteEndpoint, ADS1263_LINUX_ENDPOINT,
                          timeout);
}

static int32_t App_connectAdc(Ads1263 *device, uint8_t *acquiring)
{
    int32_t status = Ads1263_resetAndConfigure(device);
    /* STM always sends START1, even when the observed registers are wrong. */
    int32_t startStatus = Ads1263_start(device);
    if (startStatus != SystemP_SUCCESS) status = startStatus;
    *acquiring = (status == SystemP_SUCCESS) ? 1U : 0U;
    return status;
}

static void App_sendDiagnostic(Ads1263 *device, uint8_t channel,
                                uint8_t flags, uint32_t sequence)
{
    Ads1263DiagnosticFrame frame;
    memset(&frame, 0, sizeof(frame));
    frame.magic = ADS1263_DIAGNOSTIC_MAGIC;
    frame.version = ADS1263_DIAGNOSTIC_VERSION;
    frame.channel = channel;
    frame.flags = flags;
    frame.length = 0U;
    frame.sequence = sequence;
    frame.timestampUs = ClockP_getTimeUsec(); /* readout time, not conversion time */
    frame.spiStatus = (flags & ADS1263_DIAG_MUX_WRITTEN) != 0U ?
                      SystemP_TIMEOUT : SystemP_FAILURE; /* waiting, not aborted */
    if ((flags & (ADS1263_DIAG_MUX_WRITTEN | ADS1263_DIAG_DRDY_LOW)) ==
        (ADS1263_DIAG_MUX_WRITTEN | ADS1263_DIAG_DRDY_LOW))
    {
        frame.length = 5U;
        frame.spiStatus = Ads1263_readRaw(device, frame.rx);
    }
    frame.crc32 = Ads1263_crc32(&frame, offsetof(Ads1263DiagnosticFrame, crc32));
    (void)App_send(&frame, sizeof(frame), SystemP_NO_WAIT);
}

void ads1263_app_main(void *args)
{
    Ads1263 device;
    Ads1263StreamFrame frame;
    Ads1263Sample adc1;
    RPMessage_CreateParams createParams;
    uint32_t resetBase;
    uint32_t drdyBase;
    uint32_t sequence = 0U;
    uint32_t ioErrors = 0U;
    int32_t pressure = 0, thermocouple = 0;
    uint8_t pairValid = 0U;
    uint8_t scanChannel = 1U, scanPending = 0U, muxWritten = 0U;
    uint64_t scanStarted = 0U;
    uint8_t lastStatus = 0U;
    uint8_t driverReady = 0U;
    uint8_t online = 0U;
    uint8_t acquiring = 0U;
    uint8_t diagnostic = 0U;
    uint64_t diagnosticHeartbeat = 0U;
    uint32_t diagnosticSequence = 0U;
    int32_t status;

    (void)args;
    memset(&device, 0, sizeof(device));
    /* ads1263.c owns GPIO CS; use only this core's assigned DMA resources. */
    gMcspiOpenParams[CONFIG_ADS1263_MCSPI].transferTimeout =
        ClockP_usecToTicks(100000U);
    if (App_dmaResourcesOwned() != 0U) Drivers_open();
    else DebugP_log("[ADS1263] DMA resources unavailable for this R5; SPI not opened\r\n");
    Board_driversOpen();
    if (gMcspiHandle[CONFIG_ADS1263_MCSPI] != NULL)
    {
        uint32_t base = MCSPI_getBaseAddr(gMcspiHandle[CONFIG_ADS1263_MCSPI]);
        DebugP_log("[ADS1263] build %s %s op=%u base=%08x conf=%08x ctrl=%08x\r\n",
                   __DATE__, __TIME__,
                   gMcspiConfig[CONFIG_ADS1263_MCSPI].attrs->operMode, base,
                   MCSPI_readChConf(base, 0U), MCSPI_readChCtrlReg(base, 0U));
    }
    status = RPMessage_waitForLinuxReady(SystemP_WAIT_FOREVER);
    if (status == SystemP_SUCCESS)
    {
        status = IpcNotify_registerClient(IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                                          App_remoteprocCallback, NULL);
    }
    DebugP_assert(status == SystemP_SUCCESS);

    RPMessage_CreateParams_init(&createParams);
    createParams.localEndPt = ADS1263_LINUX_ENDPOINT;
    createParams.recvCallback = App_linuxCallback;
    status = RPMessage_construct(&gLinuxEndpoint, &createParams);
    DebugP_assert(status == SystemP_SUCCESS);
    status = RPMessage_announce(CSL_CORE_ID_A53SS0_0,
                                ADS1263_LINUX_ENDPOINT,
                                ADS1263_LINUX_SERVICE);
    DebugP_assert(status == SystemP_SUCCESS);

    resetBase = (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_RESET_BASE_ADDR);
    drdyBase = (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_DRDY_BASE_ADDR);
    status = Ads1263_init(&device,
                          gMcspiHandle[CONFIG_ADS1263_MCSPI],
                          gConfigAds1263McspiChCfg[0U].chNum,
                          resetBase, ADS1263_RESET_PIN);
    driverReady = status == SystemP_SUCCESS ? 1U : 0U;
    if (status == SystemP_SUCCESS)
    {
        status = App_connectAdc(&device, &acquiring);
    }
    online = (status == SystemP_SUCCESS) ? 1U : 0U;
    DebugP_log("[ADS1263] R5FSS1-0 started, online=%u id=0x%02x\r\n",
               online, device.id);

    while (gShutdownRequested == 0U)
    {
        if (gControlPending != 0U)
        {
            Ads1263Control response;
            uintptr_t key = HwiP_disable();
            memcpy(&response, &gPendingControl, sizeof(response));
            gControlPending = 0U;
            HwiP_restore(key);

            response.status = SystemP_SUCCESS;
            switch (response.command)
            {
                case ADS1263_CONTROL_GET_STATUS:
                    break;
                case ADS1263_CONTROL_START:
                    diagnostic = 0U;
                    scanPending = 0U;
                    scanChannel = 1U;
                    if (online != 0U)
                    {
                        response.status = Ads1263_start(&device);
                        acquiring = response.status == SystemP_SUCCESS ? 1U : 0U;
                    }
                    else
                    {
                        response.status = SystemP_FAILURE;
                    }
                    break;
                case ADS1263_CONTROL_STOP:
                    diagnostic = 0U;
                    scanPending = 0U;
                    response.status = driverReady != 0U ?
                                      Ads1263_stop(&device) : SystemP_FAILURE;
                    if (response.status == SystemP_SUCCESS)
                    {
                        acquiring = 0U;
                    }
                    break;
                case ADS1263_CONTROL_RESET:
                    diagnostic = 0U;
                    scanPending = 0U;
                    scanChannel = 1U;
                    online = (driverReady != 0U) &&
                             (App_connectAdc(&device, &acquiring) ==
                              SystemP_SUCCESS) ? 1U : 0U;
                    response.status = online != 0U ?
                                      SystemP_SUCCESS : SystemP_FAILURE;
                    break;
                case ADS1263_CONTROL_DIAGNOSTIC:
                    /* Explicit raw inspection attempts the SAME ADC1 settings
                     * for both inputs even if initialization failed. Failed ID or
                     * register checks remain visible in each diagnostic frame. */
                    if ((response.value == 1U) && (driverReady != 0U))
                    {
                        online = Ads1263_resetAndConfigure(&device) == SystemP_SUCCESS ? 1U : 0U;
                        response.status = Ads1263_start(&device);
                        diagnostic = response.status == SystemP_SUCCESS ? 1U : 0U;
                        acquiring = diagnostic;
                        diagnosticHeartbeat = ClockP_getTimeUsec();
                        scanPending = 0U;
                        scanChannel = 1U;
                    }
                    else if ((response.value == 2U) && (diagnostic != 0U))
                        diagnosticHeartbeat = ClockP_getTimeUsec();
                    else if (response.value == 0U)
                    {
                        if (diagnostic != 0U)
                        {
                            response.status = Ads1263_stop(&device);
                            diagnostic = 0U;
                            acquiring = 0U;
                            scanPending = 0U;
                        }
                    }
                    else response.status = SystemP_FAILURE;
                    break;
                default:
                    response.status = SystemP_FAILURE;
                    break;
            }
            response.command |= ADS1263_CONTROL_ACK;
            response.value = App_flags(online, acquiring);
            response.crc32 = Ads1263_crc32(&response,
                                           offsetof(Ads1263Control, crc32));
            (void)App_send(&response, sizeof(response), SystemP_WAIT_FOREVER);
            gStatusRequested = 1U;
        }

        if (gStatusRequested != 0U)
        {
            App_fillFrame(&frame, &device, ADS1263_FRAME_STATUS, lastStatus,
                          sequence, (int32_t)device.id, thermocouple,
                          App_flags(online, acquiring), ioErrors);
            (void)App_send(&frame, sizeof(frame), SystemP_NO_WAIT);
            gStatusRequested = 0U;
        }

        if (diagnostic != 0U)
        {
            uint64_t now = ClockP_getTimeUsec();
            /* Never leave an unattended diagnostic acquisition running. */
            if ((now - diagnosticHeartbeat) > 5000000U)
            {
                (void)Ads1263_stop(&device);
                diagnostic = 0U;
                acquiring = 0U;
                scanPending = 0U;
                DebugP_log("[ADS1263] diagnostic lease expired; acquisition stopped\r\n");
            }
        }

        if (((online == 0U) && (diagnostic == 0U)) || (acquiring == 0U))
        {
            ClockP_usleep(ADS1263_POLL_INTERVAL_US);
            continue;
        }

        if (scanPending == 0U)
        {
            if (scanChannel == 1U) pairValid = 0U;
            muxWritten = Ads1263_selectInput(&device, scanChannel) == SystemP_SUCCESS ? 1U : 0U;
            scanStarted = ClockP_getTimeUsec(); /* AFTER WREG INPMUX */
            scanPending = 1U;
        }
        /* STM: keep this mux selected until DRDY LOW. An elapsed-time report
         * must NOT trigger another WREG, read, restart or channel switch.
         * The outer loop remains responsive to STOP/RESET/shutdown/lease. */
        if ((muxWritten != 0U) && (GPIO_pinRead(drdyBase, ADS1263_DRDY_PIN) != 0U))
        {
            if (ClockP_getTimeUsec() - scanStarted >= ADS1263_WAIT_REPORT_US)
            {
                if (diagnostic != 0U)
                    App_sendDiagnostic(&device, scanChannel,
                        (online != 0U ? ADS1263_DIAG_CONFIG_OK : 0U) |
                        ADS1263_DIAG_MUX_WRITTEN, diagnosticSequence++);
                scanStarted = ClockP_getTimeUsec();
            }
            ClockP_usleep(ADS1263_POLL_INTERVAL_US);
            continue;
        }

        if (diagnostic != 0U)
        {
            uint8_t flags = (online != 0U ? ADS1263_DIAG_CONFIG_OK : 0U) |
                            (muxWritten != 0U ? ADS1263_DIAG_MUX_WRITTEN : 0U) |
                            (GPIO_pinRead(drdyBase, ADS1263_DRDY_PIN) == 0U ?
                             ADS1263_DIAG_DRDY_LOW : 0U);
            /* Expose raw RX even if initialization failed. A waiting event has
             * length=0, not a fabricated zero sample. No checksum byte is read. */
            App_sendDiagnostic(&device, scanChannel, flags, diagnosticSequence++);
            scanChannel = scanChannel == 1U ? 2U : 1U;
            scanPending = 0U;
            continue; /* Diagnostic frames never enter the normal sample path. */
        }

        if ((muxWritten == 0U) || (GPIO_pinRead(drdyBase, ADS1263_DRDY_PIN) != 0U))
        {
            ioErrors++;
        }
        else
        {
            status = Ads1263_readAdc1(&device, &adc1);
            if ((status == SystemP_SUCCESS) &&
                ((adc1.status & ADS1263_STATUS_ADC1_NEW) != 0U))
            {
                lastStatus = adc1.status;
                if (scanChannel == 1U) pressure = adc1.code;
                else thermocouple = adc1.code;
                pairValid |= 1U << (scanChannel - 1U);
                /* Publish only a complete fresh pair; never relabel a stale value.
                 * Inputs are sequential, NOT simultaneous; DRDY sets the pace. */
                if (pairValid == 3U)
                {
                    App_fillFrame(&frame, &device, ADS1263_FRAME_SAMPLE, lastStatus,
                                  sequence++, pressure, thermocouple,
                                  App_flags(online, acquiring) | ADS1263_FLAG_PRESSURE_NEW |
                                  ADS1263_FLAG_THERMOCOUPLE_NEW, ioErrors);
                    if (App_send(&frame, sizeof(frame), SystemP_NO_WAIT) != SystemP_SUCCESS)
                        ioErrors++;
                }
            }
            else ioErrors++;
        }
        scanChannel = scanChannel == 1U ? 2U : 1U;
        scanPending = 0U;
    }

    /* Linux checks WFI immediately after the ACK. Quiesce the tick timer and
     * SPI before acknowledging, so a pending peripheral IRQ cannot wake WFI. */
    Drivers_close();
    DebugP_log("[ADS1263] shutdown: drivers closed, entering WFI\r\n");
    HwiP_disable();
    TimerP_stop(gClockConfig.timerBaseAddr);
    TimerP_clearOverflowInt(gClockConfig.timerBaseAddr);
    HwiP_disableInt(gClockConfig.timerHwiIntNum);
    IpcNotify_sendMsg(gShutdownRemoteCoreId, IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                      IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK, 1U);
    __asm__ __volatile__("dsb" : : : "memory");
    for (;;)
    {
        __asm__ __volatile__("wfi" : : : "memory");
    }
}
