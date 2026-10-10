/*
 *  Copyright (C) 2021 Texas Instruments Incorporated
 *
 *  Redistribution and use in source and binary forms, with or without
 *  modification, are permitted provided that the following conditions
 *  are met:
 *
 *    Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 *
 *    Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the
 *    distribution.
 *
 *    Neither the name of Texas Instruments Incorporated nor the names of
 *    its contributors may be used to endorse or promote products derived
 *    from this software without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 *  "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 *  LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 *  A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 *  OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 *  SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 *  LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 *  DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 *  THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 *  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 *  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/*
 * Auto generated file
 */

#include "ti_drivers_config.h"
#include <drivers/sciclient.h>
#include <string.h>

/*
 * IPC Notify
 */
#include <drivers/ipc_notify.h>
#include <drivers/ipc_notify/v0/ipc_notify_v0.h>


/*
 * IPC RP Message
 */
#include <drivers/ipc_rpmsg.h>

/* Number of CPUs that are enabled for IPC RPMessage */
#define IPC_RPMESSAGE_NUM_CORES           (6U)
/* Number of VRINGs for the numner of CPUs that are enabled for IPC */
#define IPC_RPMESSAGE_NUM_VRINGS          (IPC_RPMESSAGE_NUM_CORES*(IPC_RPMESSAGE_NUM_CORES-1))
/* Number of a buffers in a VRING, i.e depth of VRING queue */
#define IPC_RPMESSAGE_NUM_VRING_BUF       (8U)
/* Max size of a buffer in a VRING */
#define IPC_RPMESSAGE_MAX_VRING_BUF_SIZE  (128U)
/* Size of each VRING is
 *     number of buffers x ( size of each buffer + space for data structures of one buffer (32B) )
 */
#define IPC_RPMESSAGE_VRING_SIZE          RPMESSAGE_VRING_SIZE(IPC_RPMESSAGE_NUM_VRING_BUF, IPC_RPMESSAGE_MAX_VRING_BUF_SIZE)

/* Total Shared memory size used for IPC */
#define IPC_SHARED_MEM_SIZE               (0U)

/* Shared Memory Used for IPC.
*
* IMPORTANT: Make sure of below,
* - The section defined below should be placed at the exact same location in memory for all the CPUs
* - The memory should be marked as non-cached for all the CPUs
* - The section should be marked as NOLOAD in all the CPUs linker command file
*/
uint8_t gIpcSharedMem[IPC_SHARED_MEM_SIZE] __attribute__((aligned(128), section(".bss.ipc_vring_mem")));

/* This function is called within IpcNotify_init, this function returns core specific IPC config */
void IpcNotify_getConfig(IpcNotify_InterruptConfig **interruptConfig, uint32_t *interruptConfigNum)
{
    /* extern globals that are specific to this core */
    extern IpcNotify_InterruptConfig gIpcNotifyInterruptConfig_r5fss0_0[];
    extern uint32_t gIpcNotifyInterruptConfigNum_r5fss0_0;

    *interruptConfig = &gIpcNotifyInterruptConfig_r5fss0_0[0];
    *interruptConfigNum = gIpcNotifyInterruptConfigNum_r5fss0_0;
}


/*
 * MCSPI
 */

#include "ti_drivers_open_close.h"

uint32_t gMcspiNumCh[1] =
{
    CONFIG_ADS1263_MCSPI_NUM_CH,
};

/* MCSPI atrributes */
static MCSPI_Attrs gMcspiAttrs[CONFIG_MCSPI_NUM_INSTANCES] =
{
    {
        .baseAddr           = CSL_MCSPI1_CFG_BASE,
        .inputClkFreq       = 50000000U,
        .intrNum            = 205,
        .operMode           = MCSPI_OPER_MODE_POLLED,
        .intrPriority       = 4U,
        .chMode             = MCSPI_CH_MODE_SINGLE,
        .pinMode            = MCSPI_PINMODE_4PIN,
        .initDelay          = MCSPI_INITDLY_0,
        .multiWordAccess    = FALSE,

    },
};


/* MCSPI objects - initialized by the driver */
static MCSPI_Object gMcspiObjects[CONFIG_MCSPI_NUM_INSTANCES];
/* MCSPI driver configuration */
MCSPI_Config gMcspiConfig[CONFIG_MCSPI_NUM_INSTANCES] =
{
    {
        &gMcspiAttrs[CONFIG_ADS1263_MCSPI],
        &gMcspiObjects[CONFIG_ADS1263_MCSPI],
    },
};

uint32_t gMcspiConfigNum = CONFIG_MCSPI_NUM_INSTANCES;

#include <drivers/mcspi/v0/lld/dma/mcspi_dma.h>

MCSPI_DmaHandle gMcspiDmaHandle[0] =
{
};


uint32_t gMcspiDmaConfigNum = CONFIG_MCSPI_NUM_DMA_INSTANCES;

/*
 * UDMA
 */
 #include <drivers/udma.h>
/* UDMA driver instance object */
Udma_DrvObject          gUdmaDrvObj[CONFIG_UDMA_NUM_INSTANCES];
/* UDMA driver instance init params */
static Udma_InitPrms    gUdmaInitPrms[CONFIG_UDMA_NUM_INSTANCES] =
{
    {
        .instId             = UDMA_INST_ID_PKTDMA_0,
        .skipGlobalEventReg = FALSE,
        .virtToPhyFxn       = Udma_defaultVirtToPhyFxn,
        .phyToVirtFxn       = Udma_defaultPhyToVirtFxn,
    },
};

/*
 * GPIO
 */

/* ----------- GPIO Direction, Trigger, Interrupt initialization ----------- */

void GPIO_init()
{
    uint32_t    baseAddr;

    /* Instance 0 */
    /* Get address after translation translate */
    baseAddr = (uint32_t) AddrTranslateP_getLocalAddr(ADS1263_DRDY_BASE_ADDR);

    GPIO_setDirMode(baseAddr, ADS1263_DRDY_PIN, ADS1263_DRDY_DIR);
    /* Instance 1 */
    /* Get address after translation translate */
    baseAddr = (uint32_t) AddrTranslateP_getLocalAddr(ADS1263_RESET_BASE_ADDR);
    GPIO_pinWriteLow(baseAddr, ADS1263_RESET_PIN);

    GPIO_setDirMode(baseAddr, ADS1263_RESET_PIN, ADS1263_RESET_DIR);
}


/* ----------- GPIO Interrupt de-initialization ----------- */
void GPIO_deinit()
{

}


/*
 * UART
 */

/* UART atrributes */
static UART_Attrs gUartAttrs[CONFIG_UART_NUM_INSTANCES] =
{
        {
            .baseAddr           = CSL_UART0_BASE,
            .inputClkFreq       = 48000000U,
        },
};
/* UART objects - initialized by the driver */
static UART_Object gUartObjects[CONFIG_UART_NUM_INSTANCES];
/* UART driver configuration */
UART_Config gUartConfig[CONFIG_UART_NUM_INSTANCES] =
{
        {
            &gUartAttrs[CONFIG_UART0],
            &gUartObjects[CONFIG_UART0],
        },
};


uint32_t gUartConfigNum = CONFIG_UART_NUM_INSTANCES;

#include <drivers/uart/v0/lld/dma/uart_dma.h>
#include <drivers/udma.h>
UART_DmaHandle gUartDmaHandle[] =
{

};
Udma_DrvObject gUdmaDrvObj[] =
{

};

uint32_t gUartDmaConfigNum = CONFIG_UART_NUM_DMA_INSTANCES;


void Drivers_uartInit(void)
{
    UART_init();
}


/*
 * MCU_LBIST
 */

uint32_t gMcuLbistTestStatus = 0U;

void SDL_lbist_selftest(void)
{
}

void Pinmux_init(void);
void PowerClock_init(void);
void PowerClock_deinit(void);
/*
 * Common Functions
 */
void System_init(void)
{
    /* DPL init sets up address transalation unit, on some CPUs this is needed
     * to access SCICLIENT services, hence this needs to happen first
     */
    Dpl_init();
    /* We should do sciclient init before we enable power and clock to the peripherals */
    /* SCICLIENT init */
    {
        int32_t retVal = SystemP_SUCCESS;

        retVal = Sciclient_init(CSL_CORE_ID_R5FSS0_0);
        DebugP_assertNoLog(SystemP_SUCCESS == retVal);
    }

    
    /* initialize PMU */
    CycleCounterP_init(SOC_getSelfCpuClk());

    PowerClock_init();
    /* Now we can do pinmux */
    Pinmux_init();
    /* finally we initialize all peripheral drivers */
    /* IPC Notify */
    {
        IpcNotify_Params notifyParams;
        int32_t status;

        /* initialize parameters to default */
        IpcNotify_Params_init(&notifyParams);

        /* specify the priority of IPC Notify interrupt */
        notifyParams.intrPriority = 15U;

        /* specify the core on which this API is called */
        notifyParams.selfCoreId = CSL_CORE_ID_R5FSS0_0;

        /* list the cores that will do IPC Notify with this core
        * Make sure to NOT list 'self' core in the list below
        */
        notifyParams.numCores = 5;
        notifyParams.coreIdList[0] = CSL_CORE_ID_R5FSS0_1;
        notifyParams.coreIdList[1] = CSL_CORE_ID_R5FSS1_0;
        notifyParams.coreIdList[2] = CSL_CORE_ID_R5FSS1_1;
        notifyParams.coreIdList[3] = CSL_CORE_ID_M4FSS0_0;
        notifyParams.coreIdList[4] = CSL_CORE_ID_A53SS0_0;

        notifyParams.isMailboxIpcEnabled = 0;

        notifyParams.isCrcEnabled = 0;

        notifyParams.isIPCIntrRouter = 0;

        /* initialize the IPC Notify module */
        status = IpcNotify_init(&notifyParams);
        DebugP_assert(status==SystemP_SUCCESS);

    }
    /* IPC RPMessage */
    {
        RPMessage_Params rpmsgParams;
        int32_t status;

        /* initialize parameters to default */
        RPMessage_Params_init(&rpmsgParams);

        /* TX VRINGs */
        rpmsgParams.vringTxBaseAddr[CSL_CORE_ID_R5FSS0_1] = (uintptr_t)(&gIpcSharedMem[]);
        rpmsgParams.vringTxBaseAddr[CSL_CORE_ID_R5FSS1_0] = (uintptr_t)(&gIpcSharedMem[]);
        rpmsgParams.vringTxBaseAddr[CSL_CORE_ID_R5FSS1_1] = (uintptr_t)(&gIpcSharedMem[]);
        rpmsgParams.vringTxBaseAddr[CSL_CORE_ID_M4FSS0_0] = (uintptr_t)(&gIpcSharedMem[]);
        rpmsgParams.vringTxBaseAddr[CSL_CORE_ID_A53SS0_0] = (uintptr_t)(&gIpcSharedMem[]);
        /* RX VRINGs */
        /* Other VRING properties */
        rpmsgParams.vringSize = IPC_RPMESSAGE_VRING_SIZE;
        rpmsgParams.vringNumBuf = IPC_RPMESSAGE_NUM_VRING_BUF;
        rpmsgParams.vringMsgSize = IPC_RPMESSAGE_MAX_VRING_BUF_SIZE;
        rpmsgParams.isCrcEnabled = 0;

        /* initialize the IPC RP Message module */
        status = RPMessage_init(&rpmsgParams);
        DebugP_assert(status==SystemP_SUCCESS);
    }

    MCSPI_init();
    /* UDMA */
    {
        uint32_t        instId;
        int32_t         retVal = UDMA_SOK;

        for(instId = 0U; instId < CONFIG_UDMA_NUM_INSTANCES; instId++)
        {
            retVal += Udma_init((Udma_DrvHandle)&gUdmaDrvObj[instId], &gUdmaInitPrms[instId]);
            DebugP_assert(UDMA_SOK == retVal);
        }
    }
    GPIO_init();
    Drivers_uartInit();
}

void System_deinit(void)
{
    RPMessage_deInit();
    IpcNotify_deInit();

    MCSPI_deinit();
    /* UDMA */
    {
        uint32_t        instId;
        int32_t         retVal = UDMA_SOK;

        for(instId = 0U; instId < CONFIG_UDMA_NUM_INSTANCES; instId++)
        {
            retVal += Udma_deinit((Udma_DrvHandle)&gUdmaDrvObj[instId]);
            DebugP_assert(UDMA_SOK == retVal);
        }
    }
    GPIO_deinit();
    UART_deinit();
    PowerClock_deinit();
    /* SCICLIENT deinit */
    {
        int32_t         retVal = SystemP_SUCCESS;

        retVal = Sciclient_deinit();
        DebugP_assertNoLog(SystemP_SUCCESS == retVal);
    }

    Dpl_deinit();
}
