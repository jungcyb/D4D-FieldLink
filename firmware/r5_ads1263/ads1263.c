#include "ads1263.h"

#include <stddef.h>
#include <string.h>
#include <drivers/gpio.h>
#include <drivers/pinmux.h>
#include <kernel/dpl/CacheP.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/SystemP.h>
#include "ti_drivers_config.h"

#define ADS1263_CMD_START1 (0x09U) /* Same opcode as the working STM32 source. */
#define ADS1263_CMD_STOP1  (0x0BU)
#define ADS1263_CMD_STOP2  (0x0EU)

/* Dedicated cache lines: DMA must not invalidate adjacent stack variables.
 * This driver has one caller (the acquisition task), not concurrent users. */
static uint8_t gTx[128] __attribute__((aligned(128)));
static uint8_t gRx[128] __attribute__((aligned(128)));

/* Read-only snapshot; never changes mux, pulls, direction or output levels. */
static void Ads1263_logPins(const Ads1263 *device)
{
    DebugP_log("[ADS1263] pins(read-only) cs-out=%u cs-in=%u reset=%u drdy=%u\r\n",
               GPIO_pinOutValueRead(CSL_GPIO1_BASE, 47U),
               GPIO_pinRead(CSL_GPIO1_BASE, 47U),
               GPIO_pinRead(device->resetGpioBase, device->resetGpioPin),
               GPIO_pinRead(ADS1263_DRDY_BASE_ADDR, ADS1263_DRDY_PIN));
}

/* Caller owns CS so STM byte-wise initialization keeps CS low throughout. */
static int32_t Ads1263_exchange(Ads1263 *device, const uint8_t *tx,
                               uint8_t *rx, uint32_t count)
{
    MCSPI_Transaction transaction;
    int32_t status;
    if ((count == 0U) || (count > sizeof(gTx))) return SystemP_FAILURE;
    memcpy(gTx, tx, count);
    memset(gRx, 0, sizeof(gRx));
    CacheP_wb(gTx, sizeof(gTx), CacheP_TYPE_ALLD);
    CacheP_wbInv(gRx, sizeof(gRx), CacheP_TYPE_ALLD);
    MCSPI_Transaction_init(&transaction);
    transaction.channel = device->spiChannel;
    transaction.dataSize = 8U;
    transaction.csDisable = TRUE;
    transaction.count = count;
    transaction.txBuf = gTx;
    transaction.rxBuf = gRx;
    status = MCSPI_transfer(device->spiHandle, &transaction);
    CacheP_inv(gRx, sizeof(gRx), CacheP_TYPE_ALLD);
    memcpy(rx, gRx, count);
    if ((status != SystemP_SUCCESS) ||
        (transaction.status != MCSPI_TRANSFER_COMPLETED))
    {
        device->spiErrors++;
        return SystemP_FAILURE;
    }
    return SystemP_SUCCESS;
}

static int32_t Ads1263_transfer(Ads1263 *device, const uint8_t *tx,
                               uint8_t *rx, uint32_t count)
{
    int32_t status;
    GPIO_pinWriteLow(CSL_GPIO1_BASE, 47U);
    status = Ads1263_exchange(device, tx, rx, count);
    GPIO_pinWriteHigh(CSL_GPIO1_BASE, 47U);
    return status;
}

static int32_t Ads1263_command(Ads1263 *device, uint8_t command)
{
    uint8_t rx;
    return Ads1263_transfer(device, &command, &rx, 1U);
}

static int32_t Ads1263_readRegister(Ads1263 *device, uint8_t address,
                                    uint8_t *value)
{
    uint8_t tx[3] = {(uint8_t)(0x20U | address), 0U, 0U};
    uint8_t rx[3] = {0U};
    int32_t status = Ads1263_transfer(device, tx, rx, sizeof(tx));
    *value = rx[2];
    return status;
}

int32_t Ads1263_init(Ads1263 *device, MCSPI_Handle spiHandle,
                     uint32_t spiChannel, uint32_t resetGpioBase,
                     uint32_t resetGpioPin)
{
    const Pinmux_PerCfg_t csPad[] = {
        {PIN_SPI1_CS0, PIN_MODE(7) | PIN_INPUT_ENABLE | PIN_PULL_DISABLE},
        {PINMUX_END, PINMUX_END},
    };
    if ((device == NULL) || (spiHandle == NULL)) return SystemP_FAILURE;
    memset(device, 0, sizeof(*device));
    device->spiHandle = spiHandle;
    device->spiChannel = spiChannel;
    device->resetGpioBase = resetGpioBase;
    device->resetGpioPin = resetGpioPin;
    /* Normal bus setup. CS is always an output; signal pads remain SPI. */
    GPIO_pinWriteHigh(CSL_GPIO1_BASE, 47U);
    GPIO_setDirMode(CSL_GPIO1_BASE, 47U, GPIO_DIRECTION_OUTPUT);
    Pinmux_config(csPad, PINMUX_DOMAIN_ID_MAIN);
    GPIO_pinWriteHigh(resetGpioBase, resetGpioPin);
    GPIO_setDirMode(resetGpioBase, resetGpioPin, GPIO_DIRECTION_OUTPUT);
    return SystemP_SUCCESS;
}

int32_t Ads1263_resetAndConfigure(Ads1263 *device)
{
    GPIO_pinWriteHigh(CSL_GPIO1_BASE, 47U);
    GPIO_pinWriteLow(device->resetGpioBase, device->resetGpioPin);
    ClockP_usleep(1000U);
    GPIO_pinWriteHigh(device->resetGpioBase, device->resetGpioPin);
    ClockP_usleep(60000U);
    Ads1263_logPins(device);
    return Ads1263_configureAdc1(device);
}

int32_t Ads1263_configureAdc1(Ads1263 *device)
{
    /* Verbatim pressure STM32 init: byte-wise RREG/WREG under a single CS.
     * ID is read-only but included in the original seven-register write.
     * INTERFACE=05 enables a checksum; STM simply does not clock that byte. */
    static const uint8_t readBlock[9] = {0x20U, 0x06U, 0, 0, 0, 0, 0, 0, 0};
    static const uint8_t writeBlock[9] = {
        0x40U, 0x06U, 0x00U, 0x11U, 0x05U, 0x00U, 0x00U, 0x8BU, 0x0AU
    };
    static const uint8_t expected[4] = {0x00U, 0x00U, 0x8BU, 0x0AU};
    uint8_t defaults[9] = {0U}, readback[4] = {0U}, ignored;
    uint32_t i;
    int32_t result = SystemP_SUCCESS;
    GPIO_pinWriteLow(CSL_GPIO1_BASE, 47U);
    for (i = 0U; i < sizeof(readBlock); i++)
        if (Ads1263_exchange(device, &readBlock[i], &defaults[i], 1U) != SystemP_SUCCESS)
            result = SystemP_FAILURE;
    GPIO_pinWriteHigh(CSL_GPIO1_BASE, 47U);
    device->id = defaults[2];

    /* Do not abort on an unexpected ID: STM proceeds with these writes too. */
    GPIO_pinWriteLow(CSL_GPIO1_BASE, 47U);
    for (i = 0U; i < sizeof(writeBlock); i++)
        if (Ads1263_exchange(device, &writeBlock[i], &ignored, 1U) != SystemP_SUCCESS)
            result = SystemP_FAILURE;
    GPIO_pinWriteHigh(CSL_GPIO1_BASE, 47U);
    ClockP_usleep(10000U);
    for (i = 0U; i < sizeof(readback); i++)
        if (Ads1263_readRegister(device, (uint8_t)(3U + i), &readback[i]) != SystemP_SUCCESS)
            result = SystemP_FAILURE;
    DebugP_log("[ADS1263] STM init defaults=%02x %02x %02x %02x %02x %02x %02x; mode0/1/2/mux=%02x %02x %02x %02x\r\n",
               defaults[2], defaults[3], defaults[4], defaults[5], defaults[6],
               defaults[7], defaults[8], readback[0], readback[1], readback[2], readback[3]);
    /* Observation only: caller still sends START1 and permits explicit RAW. */
    if (((device->id & 0xE0U) != 0x20U) ||
        (memcmp(readback, expected, sizeof(expected)) != 0)) result = SystemP_FAILURE;
    return result;
}

int32_t Ads1263_start(Ads1263 *device)
{
    return Ads1263_command(device, ADS1263_CMD_START1);
}

int32_t Ads1263_selectInput(Ads1263 *device, uint8_t channel)
{
    uint8_t tx[3] = {0x46U, 0x00U, channel == 1U ? 0x01U : 0x67U};
    uint8_t rx[3];
    if ((channel != 1U) && (channel != 2U)) return SystemP_FAILURE;
    /* STM scan: WREG only. NO STOP/START or readback between MUX and DRDY. */
    return Ads1263_transfer(device, tx, rx, sizeof(tx));
}

int32_t Ads1263_stop(Ads1263 *device)
{
    int32_t status1 = Ads1263_command(device, ADS1263_CMD_STOP1);
    int32_t status2 = Ads1263_command(device, ADS1263_CMD_STOP2);
    return ((status1 == SystemP_SUCCESS) && (status2 == SystemP_SUCCESS)) ?
           SystemP_SUCCESS : SystemP_FAILURE;
}

int32_t Ads1263_readRaw(Ads1263 *device, uint8_t rx[5])
{
    const uint8_t tx[5] = {0U};
    /* Direct read, exactly as STM: status + signed 32-bit data; no opcode. */
    return Ads1263_transfer(device, tx, rx, sizeof(tx));
}

int32_t Ads1263_readAdc1(Ads1263 *device, Ads1263Sample *sample)
{
    uint8_t rx[5] = {0U};
    int32_t status = Ads1263_readRaw(device, rx);
    sample->status = rx[0];
    sample->code = (int32_t)(((uint32_t)rx[1] << 24U) |
                           ((uint32_t)rx[2] << 16U) |
                           ((uint32_t)rx[3] << 8U) | rx[4]);
    return status;
}
