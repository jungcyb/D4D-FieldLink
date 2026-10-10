#include <stdint.h>
#include <string.h>

#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/HwiP.h>
#include <kernel/dpl/SystemP.h>
#include <kernel/dpl/TaskP.h>
#include <drivers/ipc_notify.h>
#include <drivers/ipc_rpmsg.h>

#include "FreeRTOS.h"
#include "task.h"
#include "ti_drivers_open_close.h"
#include "ti_board_open_close.h"
#include "../common/ads8688_stream.h"

#define IPC_NOTIFY_CLIENT_ID_RP_MBOX     (15U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN      (0x0FFFFF14U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK  (0x0FFFFF15U)
#define RELAY_TASK_PRIORITY              (8U)
#define RELAY_TASK_STACK_SIZE            (4096U)

static RPMessage_Object gM4Endpoint;
static RPMessage_Object gLinuxEndpoint;
static TaskP_Object gM4Task;
static TaskP_Object gLinuxTask;
static uint8_t gM4TaskStack[RELAY_TASK_STACK_SIZE] __attribute__((aligned(32)));
static uint8_t gLinuxTaskStack[RELAY_TASK_STACK_SIZE] __attribute__((aligned(32)));

static volatile uint8_t gShutdownRequested;
static volatile uint8_t gLinuxReady;
static volatile uint16_t gLinuxCoreId;
static volatile uint16_t gLinuxRemoteEndpoint;
static volatile uint32_t gShutdownRemoteCoreId;

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
        RPMessage_unblock(&gM4Endpoint);
        RPMessage_unblock(&gLinuxEndpoint);
    }
}

static void App_linuxTask(void *args)
{
    uint8_t message[64] __attribute__((aligned(8)));
    uint16_t messageSize;
    uint16_t remoteCoreId;
    uint16_t remoteEndpoint;
    int32_t status;
    static char reply[] = "ADS8OK";

    (void)args;
    while (gShutdownRequested == 0U)
    {
        messageSize = sizeof(message);
        status = RPMessage_recv(&gLinuxEndpoint, message, &messageSize,
                                &remoteCoreId, &remoteEndpoint,
                                SystemP_WAIT_FOREVER);
        if (gShutdownRequested != 0U)
        {
            break;
        }
        if (status == SystemP_SUCCESS)
        {
            gLinuxCoreId = remoteCoreId;
            gLinuxRemoteEndpoint = remoteEndpoint;
            gLinuxReady = 1U;
            if ((messageSize == sizeof(Ads8688Control)) &&
                Ads8688Control_isValid((const Ads8688Control *)message))
            {
                status = RPMessage_send(message, messageSize,
                                        CSL_CORE_ID_M4FSS0_0,
                                        ADS8688_M4_R5_ENDPOINT,
                                        ADS8688_M4_R5_ENDPOINT,
                                        SystemP_WAIT_FOREVER);
                if (status != SystemP_SUCCESS)
                {
                    DebugP_log("[ADS8688 R5] control forward failed\r\n");
                }
            }
            else
            {
                DebugP_log("[ADS8688 R5] Linux subscribed: endpoint=%u\r\n",
                           remoteEndpoint);
                (void)RPMessage_send(reply, sizeof(reply) - 1U,
                                     remoteCoreId, remoteEndpoint,
                                     ADS8688_LINUX_ENDPOINT,
                                     SystemP_NO_WAIT);
            }
        }
    }
    vTaskDelete(NULL);
}

static void App_m4Task(void *args)
{
    uint8_t message[64] __attribute__((aligned(8)));
    Ads8688StreamFrame *frame = (Ads8688StreamFrame *)message;
    Ads8688Control *control = (Ads8688Control *)message;
    uint16_t messageSize;
    uint16_t remoteCoreId;
    uint16_t remoteEndpoint;
    int32_t status;
    uint32_t received = 0U;
    uint32_t invalid = 0U;

    (void)args;
    while (gShutdownRequested == 0U)
    {
        messageSize = sizeof(message);
        status = RPMessage_recv(&gM4Endpoint, message, &messageSize,
                                &remoteCoreId, &remoteEndpoint,
                                SystemP_WAIT_FOREVER);
        if (gShutdownRequested != 0U)
        {
            break;
        }
        if ((status == SystemP_SUCCESS) &&
            (messageSize == sizeof(Ads8688StreamFrame)) &&
            Ads8688Stream_isValid(frame))
        {
            received++;
            if (gLinuxReady != 0U)
            {
                (void)RPMessage_send(frame, sizeof(*frame),
                                     gLinuxCoreId, gLinuxRemoteEndpoint,
                                     ADS8688_LINUX_ENDPOINT,
                                     SystemP_NO_WAIT);
            }
            if ((received % 1000U) == 0U)
            {
                DebugP_log("[ADS8688 R5] received=%u invalid=%u linux=%u\r\n",
                           received, invalid, gLinuxReady);
            }
        }
        else if ((status == SystemP_SUCCESS) &&
                 (messageSize == sizeof(Ads8688Control)) &&
                 Ads8688Control_isValid(control))
        {
            if (gLinuxReady != 0U)
            {
                (void)RPMessage_send(control, sizeof(*control),
                                     gLinuxCoreId, gLinuxRemoteEndpoint,
                                     ADS8688_LINUX_ENDPOINT,
                                     SystemP_WAIT_FOREVER);
            }
        }
        else
        {
            invalid++;
        }
    }
    vTaskDelete(NULL);
}

void ads8688_relay_main(void *args)
{
    RPMessage_CreateParams createParams;
    TaskP_Params taskParams;
    int32_t status;

    (void)args;
    Drivers_open();
    Board_driversOpen();
    DebugP_log("[ADS8688 R5] relay started\r\n");

    status = RPMessage_waitForLinuxReady(SystemP_WAIT_FOREVER);
    DebugP_assert(status == SystemP_SUCCESS);
    status = IpcNotify_registerClient(IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                                      App_remoteprocCallback, NULL);
    DebugP_assert(status == SystemP_SUCCESS);

    RPMessage_CreateParams_init(&createParams);
    createParams.localEndPt = ADS8688_M4_R5_ENDPOINT;
    status = RPMessage_construct(&gM4Endpoint, &createParams);
    DebugP_assert(status == SystemP_SUCCESS);

    RPMessage_CreateParams_init(&createParams);
    createParams.localEndPt = ADS8688_LINUX_ENDPOINT;
    status = RPMessage_construct(&gLinuxEndpoint, &createParams);
    DebugP_assert(status == SystemP_SUCCESS);
    status = RPMessage_announce(CSL_CORE_ID_A53SS0_0,
                                ADS8688_LINUX_ENDPOINT,
                                ADS8688_LINUX_SERVICE);
    DebugP_assert(status == SystemP_SUCCESS);

    TaskP_Params_init(&taskParams);
    taskParams.name = "ADS8688_M4_RX";
    taskParams.stackSize = sizeof(gM4TaskStack);
    taskParams.stack = gM4TaskStack;
    taskParams.priority = RELAY_TASK_PRIORITY;
    taskParams.taskMain = App_m4Task;
    status = TaskP_construct(&gM4Task, &taskParams);
    DebugP_assert(status == SystemP_SUCCESS);

    TaskP_Params_init(&taskParams);
    taskParams.name = "ADS8688_LINUX";
    taskParams.stackSize = sizeof(gLinuxTaskStack);
    taskParams.stack = gLinuxTaskStack;
    taskParams.priority = RELAY_TASK_PRIORITY;
    taskParams.taskMain = App_linuxTask;
    status = TaskP_construct(&gLinuxTask, &taskParams);
    DebugP_assert(status == SystemP_SUCCESS);

    IpcNotify_syncAll(SystemP_WAIT_FOREVER);
    DebugP_log("[ADS8688 R5] M4 synchronized\r\n");
    while (gShutdownRequested == 0U)
    {
        vTaskDelay(pdMS_TO_TICKS(10U));
    }

    vTaskDelay(pdMS_TO_TICKS(10U));
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
