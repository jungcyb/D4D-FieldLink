#include "ads1263.h"

#include <drivers/gpio.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>

/* MCSPI usage follows the SDK mcspi_loopback example: MCSPI_Transaction_init,
 * channel from gConfig...ChCfg, dataSize 8, csDisable TRUE, MCSPI_transfer.
 * Hardware CS0 is asserted for the whole transaction, which gives the same
 * CS framing as the STM32 reference (CS low / bytes / CS high per command). */
int32_t Ads1263_transaction(Ads1263 *obj, uint8_t *tx, uint8_t *rx, uint32_t count)
{
    MCSPI_Transaction spiTransaction;
    int32_t transferOK;

    MCSPI_Transaction_init(&spiTransaction);
    spiTransaction.channel   = obj->spiChannel;
    spiTransaction.dataSize  = 8U;
    spiTransaction.csDisable = TRUE;
    spiTransaction.count     = count;
    spiTransaction.txBuf     = (void *)tx;
    spiTransaction.rxBuf     = (void *)rx;
    spiTransaction.args      = NULL;

    transferOK = MCSPI_transfer(obj->spiHandle, &spiTransaction);
    if ((SystemP_SUCCESS != transferOK) ||
        (MCSPI_TRANSFER_COMPLETED != spiTransaction.status)) {
        obj->spiErrors++;
        return SystemP_FAILURE;
    }
    return SystemP_SUCCESS;
}

static int32_t Ads1263_writeReg(Ads1263 *obj, uint8_t reg, uint8_t val)
{
    uint8_t tx[3] = {ADS1263_CMD_WREG | reg, 0x00U, val};
    uint8_t rx[3] = {0};
    return Ads1263_transaction(obj, tx, rx, 3U);
}

static uint8_t Ads1263_readReg(Ads1263 *obj, uint8_t reg)
{
    uint8_t tx[3] = {ADS1263_CMD_RREG | reg, 0x00U, 0x00U};
    uint8_t rx[3] = {0};
    (void)Ads1263_transaction(obj, tx, rx, 3U);
    return rx[2];
}

static int32_t Ads1263_sendCmd(Ads1263 *obj, uint8_t cmd)
{
    uint8_t tx[1] = {cmd};
    uint8_t rx[1] = {0};
    return Ads1263_transaction(obj, tx, rx, 1U);
}

/* GPIO usage follows the SDK gpio_led_blink example: translated base address,
 * GPIO_setDirMode with the SysConfig direction, then pinWrite/pinRead. */
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
    obj->spiErrors     = 0U;

    GPIO_pinWriteHigh(resetBase, resetPin);
    GPIO_setDirMode(resetBase, resetPin, GPIO_DIRECTION_OUTPUT);
    GPIO_setDirMode(drdyBase, drdyPin, GPIO_DIRECTION_INPUT);

    return (spiHandle == NULL) ? SystemP_FAILURE : SystemP_SUCCESS;
}

void Ads1263_hardwareReset(Ads1263 *obj)
{
    GPIO_pinWriteLow(obj->resetGpioBase, obj->resetGpioPin);
    ClockP_usleep(1000U);
    GPIO_pinWriteHigh(obj->resetGpioBase, obj->resetGpioPin);
    ClockP_usleep(60000U);
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

/* Direct read as in the STM32 reference: five zero bytes, status then code. */
int32_t Ads1263_readAdc1(Ads1263 *obj, Ads1263Sample *sample)
{
    uint8_t tx[5] = {0};
    uint8_t rx[5] = {0};
    int32_t status;

    status = Ads1263_transaction(obj, tx, rx, 5U);
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

/* Same order, values and delays as the STM32 ads1263_init. */
int32_t Ads1263_resetAndConfigure(Ads1263 *obj, Ads1263InitReport *report)
{
    uint8_t rtx[9] = {ADS1263_CMD_RREG | 0x00U, 0x06U, 0, 0, 0, 0, 0, 0, 0};
    uint8_t wtx[9] = {ADS1263_CMD_WREG | 0x00U, 0x06U,
                      0x00U,  /* ID (read-only)           */
                      0x11U,  /* POWER default            */
                      0x05U,  /* INTERFACE: status on     */
                      0x00U,  /* MODE0: no delay          */
                      0x00U,  /* MODE1: SINC1             */
                      0x8BU,  /* MODE2: PGA bypass, 4800 SPS */
                      0x0AU}; /* INPMUX: AIN0 vs AINCOM   */
    uint8_t rx[9] = {0};
    uint32_t i;

    /* RESET is held HIGH permanently (no reset pulse); keep the power-up wait. */
    GPIO_pinWriteHigh(obj->resetGpioBase, obj->resetGpioPin);
    ClockP_usleep(60000U);

    (void)Ads1263_transaction(obj, rtx, rx, 9U);
    for (i = 0U; i < 7U; i++) {
        report->regs[i] = rx[2U + i];
    }

    (void)Ads1263_transaction(obj, wtx, rx, 9U);
    ClockP_usleep(10000U);

    report->verify[0] = Ads1263_readReg(obj, ADS1263_REG_MODE0);
    report->verify[1] = Ads1263_readReg(obj, ADS1263_REG_MODE1);
    report->verify[2] = Ads1263_readReg(obj, ADS1263_REG_MODE2);
    report->verify[3] = Ads1263_readReg(obj, ADS1263_REG_INPMUX);

    (void)Ads1263_sendCmd(obj, ADS1263_CMD_START1);
    return (obj->spiErrors == 0U) ? SystemP_SUCCESS : SystemP_FAILURE;
}
