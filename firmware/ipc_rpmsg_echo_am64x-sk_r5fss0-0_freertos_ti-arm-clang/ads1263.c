#include "ads1263.h"

#include <drivers/gpio.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>

/* One CS frame: full-duplex transfer of `count` bytes, CS asserted for the
 * whole frame and released at the end (csDisable=TRUE => one frame per call).
 * Polling mode: no UDMA, no cache ops needed. */
static int32_t Ads1263_xfer(Ads1263 *obj, uint8_t *tx, uint8_t *rx, uint32_t count)
{
    MCSPI_Transaction transaction;
    int32_t status;

    MCSPI_Transaction_init(&transaction);
    transaction.channel   = obj->spiChannel;
    transaction.txBuf     = (void *)tx;
    transaction.rxBuf     = (void *)rx;
    transaction.count     = count;
    transaction.dataSize  = 8U;
    transaction.csDisable = TRUE;

    status = MCSPI_transfer(obj->spiHandle, &transaction);
    if ((status != SystemP_SUCCESS) ||
        (transaction.status != MCSPI_TRANSFER_COMPLETED)) {
        obj->spiErrors++;
        return SystemP_FAILURE;
    }
    return SystemP_SUCCESS;
}

int32_t Ads1263_init(Ads1263 *obj, MCSPI_Handle spiHandle, uint32_t spiChannel,
                     uint32_t resetBase, uint32_t resetPin,
                     uint32_t drdyBase, uint32_t drdyPin)
{
    obj->spiHandle     = spiHandle;
    obj->spiChannel    = spiChannel;
    obj->resetGpioBase = resetBase;
    obj->resetGpioPin  = resetPin;
    obj->drdyGpioBase  = drdyBase;
    obj->drdyGpioPin   = drdyPin;
    obj->id            = 0U;
    obj->spiErrors     = 0U;

    if (spiHandle == NULL) {
        return SystemP_FAILURE;
    }
    return SystemP_SUCCESS;
}

static void Ads1263_reset(Ads1263 *obj)
{
    GPIO_pinWriteLow(obj->resetGpioBase, obj->resetGpioPin);
    ClockP_usleep(1000U);
    GPIO_pinWriteHigh(obj->resetGpioBase, obj->resetGpioPin);
    ClockP_usleep(60000U);
}

static uint8_t Ads1263_readReg(Ads1263 *obj, uint8_t reg)
{
    uint8_t tx[3] = {ADS1263_CMD_RREG | reg, 0x00U, 0x00U};
    uint8_t rx[3] = {0};
    (void)Ads1263_xfer(obj, tx, rx, 3U);
    return rx[2];
}

static int32_t Ads1263_writeReg(Ads1263 *obj, uint8_t reg, uint8_t val)
{
    uint8_t tx[3] = {ADS1263_CMD_WREG | reg, 0x00U, val};
    uint8_t rx[3] = {0};
    return Ads1263_xfer(obj, tx, rx, 3U);
}

static int32_t Ads1263_sendCmd(Ads1263 *obj, uint8_t cmd)
{
    uint8_t tx[1] = {cmd};
    uint8_t rx[1] = {0};
    return Ads1263_xfer(obj, tx, rx, 1U);
}

int32_t Ads1263_start(Ads1263 *obj)
{
    return Ads1263_sendCmd(obj, ADS1263_CMD_START1);
}

int32_t Ads1263_stop(Ads1263 *obj)
{
    return Ads1263_sendCmd(obj, ADS1263_CMD_STOP);
}

int32_t Ads1263_selectInput(Ads1263 *obj, uint8_t mux)
{
    return Ads1263_writeReg(obj, ADS1263_REG_INPMUX, mux);
}

int32_t Ads1263_waitDrdy(Ads1263 *obj, uint32_t timeoutUs)
{
    uint32_t elapsed = 0U;
    while (GPIO_pinRead(obj->drdyGpioBase, obj->drdyGpioPin) == GPIO_PIN_HIGH) {
        if (elapsed >= timeoutUs) {
            return SystemP_FAILURE;
        }
        ClockP_usleep(10U);
        elapsed += 10U;
    }
    return SystemP_SUCCESS;
}

int32_t Ads1263_readAdc1(Ads1263 *obj, Ads1263Sample *sample)
{
    uint8_t tx[5] = {0};
    uint8_t rx[5] = {0};
    int32_t status;

    status = Ads1263_xfer(obj, tx, rx, 5U);
    if (status != SystemP_SUCCESS) {
        return status;
    }
    sample->status = rx[0];
    sample->code   = (int32_t)(((uint32_t)rx[1] << 24) |
                               ((uint32_t)rx[2] << 16) |
                               ((uint32_t)rx[3] << 8)  |
                               ((uint32_t)rx[4]));
    return SystemP_SUCCESS;
}

int32_t Ads1263_resetAndConfigure(Ads1263 *obj)
{
    /* 7 registers written starting at 0x00 (ID..INPMUX). */
    uint8_t wregs[7] = {
        0x00U,  /* ID (read-only)   */
        0x11U,  /* POWER            */
        0x05U,  /* INTERFACE: status on */
        0x00U,  /* MODE0            */
        0x00U,  /* MODE1: SINC1     */
        0x8BU,  /* MODE2: PGA bypass, 4800 SPS */
        0x0AU   /* INPMUX: AIN0 vs AINCOM */
    };
    uint8_t rtx[9], rrx[9];
    uint8_t wtx[9], wrx[9];
    uint32_t i;
    uint8_t v0, v1, v2, v3;
    int32_t status;

    Ads1263_reset(obj);

    /* Read 7 registers from 0x00 (sanity check). */
    rtx[0] = ADS1263_CMD_RREG;
    rtx[1] = 0x06U;
    for (i = 0U; i < 7U; i++) {
        rtx[2U + i] = 0x00U;
    }
    if (Ads1263_xfer(obj, rtx, rrx, 9U) != SystemP_SUCCESS) {
        DebugP_log("ADS1263: 7-reg read failed\n");
        return SystemP_FAILURE;
    }
    DebugP_log("ADS1263: regs=[%02X %02X %02X %02X %02X %02X %02X]\n",
               rrx[2], rrx[3], rrx[4], rrx[5], rrx[6], rrx[7], rrx[8]);

    /* Write 7 registers from 0x00. */
    wtx[0] = ADS1263_CMD_WREG | 0x00U;
    wtx[1] = 0x06U;
    for (i = 0U; i < 7U; i++) {
        wtx[2U + i] = wregs[i];
    }
    if (Ads1263_xfer(obj, wtx, wrx, 9U) != SystemP_SUCCESS) {
        DebugP_log("ADS1263: 7-reg write failed\n");
        return SystemP_FAILURE;
    }
    ClockP_usleep(10000U);

    /* Verify. */
    v0 = Ads1263_readReg(obj, ADS1263_REG_MODE0);
    v1 = Ads1263_readReg(obj, ADS1263_REG_MODE1);
    v2 = Ads1263_readReg(obj, ADS1263_REG_MODE2);
    v3 = Ads1263_readReg(obj, ADS1263_REG_INPMUX);
    DebugP_log("ADS1263: verify MODE0=%02X MODE1=%02X MODE2=%02X INPMUX=%02X (expect 00 00 8B 0A)\n",
               v0, v1, v2, v3);

    status = Ads1263_start(obj);
    if (status != SystemP_SUCCESS) {
        DebugP_log("ADS1263: START failed\n");
        return status;
    }
    return SystemP_SUCCESS;
}
