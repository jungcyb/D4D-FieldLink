#include "ads8688.h"

#include <stddef.h>
#include <drivers/gpio.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/SystemP.h>

#define ADS8688_REGISTER_FRAME_BYTES   (3U)
#define ADS8688_CONVERSION_FRAME_BYTES (4U)
#define ADS8688_POWER_UP_DELAY_US      (15000U)

static int32_t Ads8688_transfer(Ads8688 *device,
                               const uint8_t *txBuffer,
                               uint8_t *rxBuffer,
                               uint32_t byteCount)
{
    MCSPI_Transaction transaction;
    int32_t status;

    MCSPI_Transaction_init(&transaction);
    transaction.channel = device->spiChannel;
    transaction.dataSize = 8U;
    transaction.csDisable = TRUE;
    transaction.count = byteCount;
    transaction.txBuf = (void *)txBuffer;
    transaction.rxBuf = (void *)rxBuffer;

    status = MCSPI_transfer(device->spiHandle, &transaction);
    if ((status != SystemP_SUCCESS) ||
        (transaction.status != MCSPI_TRANSFER_COMPLETED))
    {
        DebugP_logError("[ADS8688] SPI transfer failed: status=%d transaction=%u bytes=%u\r\n",
                        status, transaction.status, byteCount);
        return SystemP_FAILURE;
    }

    return SystemP_SUCCESS;
}

static int32_t Ads8688_transferCommand(Ads8688 *device,
                                       uint16_t command,
                                       uint16_t *conversionCode)
{
    uint8_t txBuffer[ADS8688_CONVERSION_FRAME_BYTES] =
    {
        (uint8_t)(command >> 8U),
        (uint8_t)command,
        0U,
        0U,
    };
    uint8_t rxBuffer[ADS8688_CONVERSION_FRAME_BYTES] = {0U};
    int32_t status;

    status = Ads8688_transfer(device, txBuffer, rxBuffer,
                              ADS8688_CONVERSION_FRAME_BYTES);
    if ((status == SystemP_SUCCESS) && (conversionCode != NULL))
    {
        *conversionCode = ((uint16_t)rxBuffer[2] << 8U) | rxBuffer[3];
    }

    return status;
}

static uint8_t Ads8688_firstEnabledChannel(uint8_t channelMask)
{
    uint8_t channel;

    for (channel = 0U; channel < ADS8688_CHANNEL_COUNT; channel++)
    {
        if ((channelMask & (1U << channel)) != 0U)
        {
            return channel;
        }
    }

    return 0U;
}

static uint8_t Ads8688_nextEnabledChannel(uint8_t channelMask, uint8_t current)
{
    uint8_t offset;

    for (offset = 1U; offset <= ADS8688_CHANNEL_COUNT; offset++)
    {
        uint8_t candidate = (uint8_t)((current + offset) % ADS8688_CHANNEL_COUNT);
        if ((channelMask & (1U << candidate)) != 0U)
        {
            return candidate;
        }
    }

    return 0U;
}

int32_t Ads8688_init(Ads8688 *device,
                     MCSPI_Handle spiHandle,
                     uint32_t spiChannel,
                     uint32_t resetGpioBase,
                     uint32_t resetGpioPin)
{
    if ((device == NULL) || (spiHandle == NULL))
    {
        return SystemP_FAILURE;
    }

    device->spiHandle = spiHandle;
    device->spiChannel = spiChannel;
    device->resetGpioBase = resetGpioBase;
    device->resetGpioPin = resetGpioPin;
    device->channelMask = ADS8688_ALL_CHANNELS;
    device->nextChannel = 0U;

    GPIO_setDirMode(resetGpioBase, resetGpioPin, GPIO_DIRECTION_OUTPUT);
    GPIO_pinWriteHigh(resetGpioBase, resetGpioPin);

    return SystemP_SUCCESS;
}

int32_t Ads8688_hardwareReset(Ads8688 *device)
{
    if (device == NULL)
    {
        return SystemP_FAILURE;
    }

    /* >=400 ns enters power-down and resets all program registers. */
    GPIO_pinWriteLow(device->resetGpioBase, device->resetGpioPin);
    ClockP_usleep(1U);
    GPIO_pinWriteHigh(device->resetGpioBase, device->resetGpioPin);
    ClockP_usleep(ADS8688_POWER_UP_DELAY_US);

    return SystemP_SUCCESS;
}

int32_t Ads8688_writeRegister(Ads8688 *device, uint8_t address, uint8_t value)
{
    uint8_t txBuffer[ADS8688_REGISTER_FRAME_BYTES] =
    {
        (uint8_t)((address << 1U) | 1U),
        value,
        0U,
    };
    uint8_t rxBuffer[ADS8688_REGISTER_FRAME_BYTES] = {0U};
    int32_t status;

    status = Ads8688_transfer(device, txBuffer, rxBuffer,
                              ADS8688_REGISTER_FRAME_BYTES);
    if ((status == SystemP_SUCCESS) && (rxBuffer[2] != value))
    {
        DebugP_logError("[ADS8688] register write mismatch: addr=0x%02x expected=0x%02x rx=%02x %02x %02x\r\n",
                        address, value, rxBuffer[0], rxBuffer[1], rxBuffer[2]);
        status = SystemP_FAILURE;
    }

    return status;
}

int32_t Ads8688_readRegister(Ads8688 *device, uint8_t address, uint8_t *value)
{
    uint8_t txBuffer[ADS8688_REGISTER_FRAME_BYTES] =
    {
        (uint8_t)(address << 1U),
        0U,
        0U,
    };
    uint8_t rxBuffer[ADS8688_REGISTER_FRAME_BYTES] = {0U};
    int32_t status;

    if (value == NULL)
    {
        return SystemP_FAILURE;
    }

    status = Ads8688_transfer(device, txBuffer, rxBuffer,
                              ADS8688_REGISTER_FRAME_BYTES);
    if (status == SystemP_SUCCESS)
    {
        *value = rxBuffer[2];
        DebugP_log("[ADS8688] register read: addr=0x%02x rx=%02x %02x %02x\r\n",
                   address, rxBuffer[0], rxBuffer[1], rxBuffer[2]);
    }

    return status;
}

int32_t Ads8688_configureAuto(Ads8688 *device,
                              uint8_t channelMask,
                              Ads8688_Range range)
{
    uint8_t channel;
    uint8_t readback;

    if ((device == NULL) || (channelMask == 0U))
    {
        return SystemP_FAILURE;
    }

    if (Ads8688_writeRegister(device, ADS8688_REG_FEATURE_SELECT, 0U) != SystemP_SUCCESS)
    {
        return SystemP_FAILURE;
    }
    if (Ads8688_writeRegister(device, ADS8688_REG_AUTO_SEQ_EN, channelMask) != SystemP_SUCCESS)
    {
        return SystemP_FAILURE;
    }
    if (Ads8688_writeRegister(device, ADS8688_REG_CHANNEL_POWER_DOWN,
                              (uint8_t)~channelMask) != SystemP_SUCCESS)
    {
        return SystemP_FAILURE;
    }

    for (channel = 0U; channel < ADS8688_CHANNEL_COUNT; channel++)
    {
        if (Ads8688_writeRegister(device,
                                  (uint8_t)(ADS8688_REG_RANGE_BASE + channel),
                                  (uint8_t)range) != SystemP_SUCCESS)
        {
            return SystemP_FAILURE;
        }
    }

    if ((Ads8688_readRegister(device, ADS8688_REG_AUTO_SEQ_EN, &readback) != SystemP_SUCCESS) ||
        (readback != channelMask))
    {
        return SystemP_FAILURE;
    }

    device->channelMask = channelMask;
    device->nextChannel = Ads8688_firstEnabledChannel(channelMask);
    return SystemP_SUCCESS;
}

int32_t Ads8688_startAuto(Ads8688 *device)
{
    uint16_t discardedCode;

    if (device == NULL)
    {
        return SystemP_FAILURE;
    }

    if (Ads8688_transferCommand(device, ADS8688_CMD_AUTO_RESET,
                                &discardedCode) != SystemP_SUCCESS)
    {
        return SystemP_FAILURE;
    }

    /* The first NO_OP starts channel 0; its returned value belongs to the old mode. */
    if (Ads8688_transferCommand(device, ADS8688_CMD_NO_OP,
                                &discardedCode) != SystemP_SUCCESS)
    {
        return SystemP_FAILURE;
    }

    device->nextChannel = Ads8688_firstEnabledChannel(device->channelMask);
    return SystemP_SUCCESS;
}

int32_t Ads8688_readAuto(Ads8688 *device, Ads8688_Sample *sample)
{
    int32_t status;

    if ((device == NULL) || (sample == NULL))
    {
        return SystemP_FAILURE;
    }

    status = Ads8688_transferCommand(device, ADS8688_CMD_NO_OP, &sample->code);
    if (status == SystemP_SUCCESS)
    {
        sample->channel = device->nextChannel;
        device->nextChannel = Ads8688_nextEnabledChannel(device->channelMask,
                                                         device->nextChannel);
    }

    return status;
}
