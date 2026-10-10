#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <kernel/dpl/AddrTranslateP.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/HwiP.h>
#include <kernel/dpl/SystemP.h>
#include <drivers/ipc_notify.h>
#include <drivers/ipc_rpmsg.h>

#include "ads8688.h"
#include "ti_drivers_config.h"
#include "ti_drivers_open_close.h"
#include "ti_board_config.h"
#include "ti_board_open_close.h"
#include "../common/ads8688_stream.h"

#define IPC_NOTIFY_CLIENT_ID_RP_MBOX     (15U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN      (0x0FFFFF14U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK  (0x0FFFFF15U)

static RPMessage_Object gR5Endpoint;
static volatile uint8_t gShutdownRequested;
static volatile uint32_t gShutdownRemoteCoreId;
static Ads8688Control gPendingControl;
static volatile uint8_t gControlPending;

static void App_controlCallback(RPMessage_Object *obj,
                                void *args,
                                void *data,
                                uint16_t dataLen,
                                int32_t crcStatus,
                                uint16_t remoteCoreId,
                                uint16_t remoteEndpoint)
{
    const Ads8688Control *control = (const Ads8688Control *)data;

    (void)obj;
    (void)args;
    (void)remoteCoreId;
    (void)remoteEndpoint;
    if ((crcStatus == SystemP_SUCCESS) &&
        (dataLen == sizeof(Ads8688Control)) &&
        Ads8688Control_isValid(control) &&
        (gControlPending == 0U))
    {
        memcpy(&gPendingControl, control, sizeof(gPendingControl));
        gControlPending = 1U;
    }
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

static int32_t App_readScan(Ads8688 *device, Ads8688StreamFrame *frame)
{
    Ads8688_Sample sample;
    uint32_t i;
    int32_t status = SystemP_SUCCESS;

    for (i = 0U; (i < ADS8688_STREAM_CHANNELS) &&
                 (status == SystemP_SUCCESS); i++)
    {
        status = Ads8688_readAuto(device, &sample);
        if ((status == SystemP_SUCCESS) &&
            (sample.channel < ADS8688_STREAM_CHANNELS))
        {
            frame->samples[sample.channel] = sample.code;
        }
        else if (status == SystemP_SUCCESS)
        {
            status = SystemP_FAILURE;
        }
    }
    return status;
}

static uint32_t App_batchTarget(uint32_t scanRateHz)
{
    /* Keep transport overhead low while bounding acquisition latency to 5 ms. */
    uint32_t target = scanRateHz / 200U;

    if (target < 1U)
    {
        target = 1U;
    }
    if (target > ADS8688_STREAM_BATCH_MAX)
    {
        target = ADS8688_STREAM_BATCH_MAX;
    }
    return target;
}

static int32_t App_sendBatch(Ads8688StreamFrame *frames, uint32_t count)
{
    if (count == 0U)
    {
        return SystemP_SUCCESS;
    }
    return RPMessage_send(frames,
                          (uint16_t)(count * sizeof(*frames)),
                          CSL_CORE_ID_R5FSS0_0,
                          ADS8688_M4_R5_ENDPOINT,
                          ADS8688_M4_R5_ENDPOINT,
                          SystemP_WAIT_FOREVER);
}

int main(void)
{
    Ads8688 device;
    Ads8688StreamFrame frame;
    Ads8688StreamFrame batch[ADS8688_STREAM_BATCH_MAX];
    RPMessage_CreateParams createParams;
    uint32_t resetGpioBase;
    uint64_t nextScanUs;
    uint64_t nowUs;
    uint32_t scanRateHz = ADS8688_STREAM_SCAN_RATE_HZ;
    uint32_t batchCount = 0U;
    uint32_t batchTarget = App_batchTarget(ADS8688_STREAM_SCAN_RATE_HZ);
    uint8_t acquisitionEnabled = 1U;
    int32_t status;

    System_init();
    Board_init();
    Drivers_open();
    Board_driversOpen();

    DebugP_log("[ADS8688] M4F stream started\r\n");
    status = RPMessage_waitForLinuxReady(SystemP_WAIT_FOREVER);
    if (status == SystemP_SUCCESS)
    {
        status = IpcNotify_registerClient(IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                                          App_remoteprocCallback, NULL);
    }
    DebugP_assert(status == SystemP_SUCCESS);

    RPMessage_CreateParams_init(&createParams);
    createParams.localEndPt = ADS8688_M4_R5_ENDPOINT;
    createParams.recvCallback = App_controlCallback;
    status = RPMessage_construct(&gR5Endpoint, &createParams);
    DebugP_assert(status == SystemP_SUCCESS);

    resetGpioBase = (uint32_t)AddrTranslateP_getLocalAddr(ADS8688_RESET_BASE_ADDR);
    status = Ads8688_init(&device,
                          gMcspiHandle[CONFIG_MCSPI0],
                          gConfigMcspi0ChCfg[0U].chNum,
                          resetGpioBase,
                          ADS8688_RESET_PIN);
    if (status == SystemP_SUCCESS)
    {
        status = Ads8688_hardwareReset(&device);
    }
    if (status == SystemP_SUCCESS)
    {
        status = Ads8688_configureAuto(&device,
                                       ADS8688_ALL_CHANNELS,
                                       ADS8688_RANGE_BIPOLAR_2V5REF);
    }
    if (status == SystemP_SUCCESS)
    {
        status = Ads8688_startAuto(&device);
    }
    DebugP_assert(status == SystemP_SUCCESS);

    memset(&frame, 0, sizeof(frame));
    frame.magic = ADS8688_STREAM_MAGIC;
    frame.version = ADS8688_STREAM_VERSION;
    frame.headerBytes = offsetof(Ads8688StreamFrame, samples);
    frame.scanRateHz = scanRateHz;
    frame.channelCount = ADS8688_STREAM_CHANNELS;
    frame.sampleFormat = ADS8688_STREAM_SAMPLE_U16;

    IpcNotify_syncAll(SystemP_WAIT_FOREVER);
    DebugP_log("[ADS8688] M4->R5 stream: %u scans/s, 8 channels\r\n",
               ADS8688_STREAM_SCAN_RATE_HZ);
    nextScanUs = ClockP_getTimeUsec();

    while (gShutdownRequested == 0U)
    {
        if (gControlPending != 0U)
        {
            Ads8688Control response;
            uintptr_t interruptState;

            status = App_sendBatch(batch, batchCount);
            DebugP_assert(status == SystemP_SUCCESS);
            batchCount = 0U;

            interruptState = HwiP_disable();
            memcpy(&response, &gPendingControl, sizeof(response));
            gControlPending = 0U;
            HwiP_restore(interruptState);

            response.status = SystemP_SUCCESS;
            switch (response.command)
            {
                case ADS8688_CONTROL_START:
                    acquisitionEnabled = 1U;
                    break;
                case ADS8688_CONTROL_STOP:
                    acquisitionEnabled = 0U;
                    break;
                case ADS8688_CONTROL_SET_RATE:
                    if ((response.value >= ADS8688_SCAN_RATE_MIN_HZ) &&
                        (response.value <= ADS8688_SCAN_RATE_MAX_HZ))
                    {
                        scanRateHz = response.value;
                        frame.scanRateHz = scanRateHz;
                        batchTarget = App_batchTarget(scanRateHz);
                    }
                    else
                    {
                        response.status = SystemP_FAILURE;
                    }
                    break;
                case ADS8688_CONTROL_GET_STATUS:
                    break;
                default:
                    response.status = SystemP_FAILURE;
                    break;
            }
            response.command |= ADS8688_CONTROL_ACK;
            response.value = scanRateHz;
            response.crc32 = Ads8688Stream_crc32(&response,
                offsetof(Ads8688Control, crc32));
            status = RPMessage_send(&response, sizeof(response),
                                    CSL_CORE_ID_R5FSS0_0,
                                    ADS8688_M4_R5_ENDPOINT,
                                    ADS8688_M4_R5_ENDPOINT,
                                    SystemP_WAIT_FOREVER);
            DebugP_assert(status == SystemP_SUCCESS);
            nextScanUs = ClockP_getTimeUsec();
        }

        if (acquisitionEnabled == 0U)
        {
            ClockP_usleep(1000U);
            continue;
        }

        status = App_readScan(&device, &frame);
        if (status == SystemP_SUCCESS)
        {
            frame.timestampUs = ClockP_getTimeUsec();
            frame.crc32 = Ads8688Stream_crc32(&frame,
                offsetof(Ads8688StreamFrame, crc32));
            memcpy(&batch[batchCount], &frame, sizeof(frame));
            batchCount++;
            if (batchCount >= batchTarget)
            {
                status = App_sendBatch(batch, batchCount);
                batchCount = 0U;
            }
            frame.sequence++;
            if ((frame.sequence % 1000U) == 0U)
            {
                DebugP_log("[ADS8688] sent=%u\r\n", frame.sequence);
            }
        }
        DebugP_assert(status == SystemP_SUCCESS);

        nextScanUs += (1000000U / scanRateHz);
        nowUs = ClockP_getTimeUsec();
        if (nextScanUs > nowUs)
        {
            ClockP_usleep((uint32_t)(nextScanUs - nowUs));
        }
        else
        {
            nextScanUs = nowUs;
        }
    }

    RPMessage_destruct(&gR5Endpoint);
    Board_driversClose();
    Drivers_close();
    IpcNotify_sendMsg(gShutdownRemoteCoreId, IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                      IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK, 1U);
    HwiP_disable();
    for (;;)
    {
        __asm__ __volatile__("wfi" : : : "memory");
    }
}
