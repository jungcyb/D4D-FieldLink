/* R5FSS1-0 entry for the shared ADS1263 scan task.
 *
 * Same as the CCS project's main.c, plus the Linux remoteproc shutdown
 * handshake: kernel 6.12 k3_r5 waits for SHUTDOWN_ACK + WFI before it lets
 * `echo stop > state` succeed, so without this the core can never be
 * reloaded short of a board reboot. */
#include <stdint.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/HwiP.h>
#include <kernel/dpl/SemaphoreP.h>
#include <kernel/dpl/TimerP.h>
#include <drivers/ipc_notify.h>
#include <drivers/ipc_rpmsg.h>
#include "ti_drivers_config.h"
#include "ti_dpl_config.h"
#include "ti_board_config.h"
#include "FreeRTOS.h"
#include "task.h"

#define IPC_NOTIFY_CLIENT_ID_RP_MBOX     (15U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN      (0x0FFFFF14U)
#define IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK  (0x0FFFFF15U)

#define SHUTDOWN_TASK_PRI  (configMAX_PRIORITIES - 1)
#define SCAN_TASK_PRI      (configMAX_PRIORITIES - 2)
#define TASK_SIZE          (16384U / sizeof(configSTACK_DEPTH_TYPE))

static StackType_t gScanTaskStack[TASK_SIZE] __attribute__((aligned(32)));
static StackType_t gShutdownTaskStack[TASK_SIZE] __attribute__((aligned(32)));
static StaticTask_t gScanTaskObj;
static StaticTask_t gShutdownTaskObj;
static TaskHandle_t gScanTask;
static SemaphoreP_Object gShutdownSem;
static volatile uint32_t gShutdownRemoteCoreId;

extern ClockP_Config gClockConfig;

void ads1263_scan_task(void *args);


static void scan_task(void *args)
{
    ads1263_scan_task(args);
    vTaskDelete(NULL);
}

static void remoteproc_callback(uint32_t remoteCoreId, uint16_t clientId,
                                uint32_t message, int32_t crcStatus, void *args)
{
    (void)crcStatus;
    (void)args;
    if ((clientId == IPC_NOTIFY_CLIENT_ID_RP_MBOX) &&
        (message == IPC_NOTIFY_RP_MBOX_SHUTDOWN)) {
        gShutdownRemoteCoreId = remoteCoreId;
        SemaphoreP_post(&gShutdownSem);
    }
}

static void shutdown_task(void *args)
{
    (void)args;

    DebugP_assert(RPMessage_waitForLinuxReady(SystemP_WAIT_FOREVER) == SystemP_SUCCESS);
    DebugP_assert(IpcNotify_registerClient(IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                                           remoteproc_callback, NULL) == SystemP_SUCCESS);
    SemaphoreP_pend(&gShutdownSem, SystemP_WAIT_FOREVER);

    vTaskSuspend(gScanTask);
    DebugP_log("ADS1263: shutdown requested, entering WFI\n");
    /* Linux checks WFI right after the ACK; a pending tick IRQ would wake it. */
    HwiP_disable();
    TimerP_stop(gClockConfig.timerBaseAddr);
    TimerP_clearOverflowInt(gClockConfig.timerBaseAddr);
    HwiP_disableInt(gClockConfig.timerHwiIntNum);
    IpcNotify_sendMsg(gShutdownRemoteCoreId, IPC_NOTIFY_CLIENT_ID_RP_MBOX,
                      IPC_NOTIFY_RP_MBOX_SHUTDOWN_ACK, 1U);
    __asm__ __volatile__("dsb" : : : "memory");
    for (;;) {
        __asm__ __volatile__("wfi" : : : "memory");
    }
}

int main(void)
{
    TaskHandle_t task;

    System_init();
    Board_init();
    DebugP_assert(SemaphoreP_constructBinary(&gShutdownSem, 0U) == SystemP_SUCCESS);

    gScanTask = xTaskCreateStatic(scan_task, "ads1263_scan", TASK_SIZE, NULL,
                                  SCAN_TASK_PRI, gScanTaskStack, &gScanTaskObj);
    task = xTaskCreateStatic(shutdown_task, "rproc_shutdown", TASK_SIZE, NULL,
                             SHUTDOWN_TASK_PRI, gShutdownTaskStack, &gShutdownTaskObj);
    configASSERT((gScanTask != NULL) && (task != NULL));

    vTaskStartScheduler();
    DebugP_assertNoLog(0);
    return 0;
}
