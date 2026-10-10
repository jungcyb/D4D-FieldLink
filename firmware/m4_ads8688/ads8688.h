#ifndef ADS8688_H_
#define ADS8688_H_

#include <stdint.h>
#include <drivers/mcspi.h>

#define ADS8688_CHANNEL_COUNT          (8U)
#define ADS8688_ALL_CHANNELS           (0xFFU)

#define ADS8688_CMD_NO_OP              (0x0000U)
#define ADS8688_CMD_STANDBY            (0x8200U)
#define ADS8688_CMD_POWER_DOWN         (0x8300U)
#define ADS8688_CMD_RESET_REGISTERS    (0x8500U)
#define ADS8688_CMD_AUTO_RESET         (0xA000U)
#define ADS8688_CMD_MANUAL(channel)    ((uint16_t)(0xC000U | ((uint16_t)(channel) << 10U)))

#define ADS8688_REG_AUTO_SEQ_EN        (0x01U)
#define ADS8688_REG_CHANNEL_POWER_DOWN (0x02U)
#define ADS8688_REG_FEATURE_SELECT     (0x03U)
#define ADS8688_REG_RANGE_BASE         (0x05U)

typedef enum
{
    ADS8688_RANGE_BIPOLAR_2V5REF   = 0x00U,
    ADS8688_RANGE_BIPOLAR_1V25REF  = 0x01U,
    ADS8688_RANGE_BIPOLAR_0V625REF = 0x02U,
    ADS8688_RANGE_UNIPOLAR_2V5REF  = 0x05U,
    ADS8688_RANGE_UNIPOLAR_1V25REF = 0x06U,
} Ads8688_Range;

typedef struct
{
    MCSPI_Handle spiHandle;
    uint32_t spiChannel;
    uint32_t resetGpioBase;
    uint32_t resetGpioPin;
    uint8_t channelMask;
    uint8_t nextChannel;
} Ads8688;

typedef struct
{
    uint16_t code;
    uint8_t channel;
} Ads8688_Sample;

int32_t Ads8688_init(Ads8688 *device,
                     MCSPI_Handle spiHandle,
                     uint32_t spiChannel,
                     uint32_t resetGpioBase,
                     uint32_t resetGpioPin);
int32_t Ads8688_hardwareReset(Ads8688 *device);
int32_t Ads8688_writeRegister(Ads8688 *device, uint8_t address, uint8_t value);
int32_t Ads8688_readRegister(Ads8688 *device, uint8_t address, uint8_t *value);
int32_t Ads8688_configureAuto(Ads8688 *device, uint8_t channelMask, Ads8688_Range range);
int32_t Ads8688_startAuto(Ads8688 *device);
int32_t Ads8688_readAuto(Ads8688 *device, Ads8688_Sample *sample);

#endif
