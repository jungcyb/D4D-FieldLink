#include <stdlib.h>
#include <kernel/dpl/DebugP.h>
#include "ti_drivers_config.h"
#include "ti_board_config.h"
#include "FreeRTOS.h"
#include "task.h"

#define MAIN_TASK_PRI  (configMAX_PRIORITIES - 1)
#define MAIN_TASK_SIZE (16384U / sizeof(configSTACK_DEPTH_TYPE))

static StackType_t gMainTaskStack[MAIN_TASK_SIZE] __attribute__((aligned(32)));
static StaticTask_t gMainTaskObject;

void ads1263_app_main(void *args);

static void freertos_main(void *args)
{
    ads1263_app_main(args);
    vTaskDelete(NULL);
}

int main(void)
{
    TaskHandle_t task;

    System_init();
    Board_init();
    task = xTaskCreateStatic(freertos_main, "ads1263_main", MAIN_TASK_SIZE,
                             NULL, MAIN_TASK_PRI, gMainTaskStack,
                             &gMainTaskObject);
    configASSERT(task != NULL);
    vTaskStartScheduler();
    DebugP_assertNoLog(0);
    return 0;
}
