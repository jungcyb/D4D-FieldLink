#ifndef ADS1263_H_
#define ADS1263_H_

#include <stdint.h>
#include <drivers/mcspi.h>

#define ADS1263_STATUS_ADC1_NEW    (0x40U)
/* Report a long DRDY wait, but NEVER abandon/switch the requested input. */
#define ADS1263_WAIT_REPORT_US    (1000000U)

typedef struct
{
    MCSPI_Handle spiHandle;
    uint32_t spiChannel;
    uint32_t resetGpioBase;
    uint32_t resetGpioPin;
    uint32_t spiErrors;
    uint32_t crcErrors;
    uint8_t id;
} Ads1263;

typedef struct
{
    int32_t code;
    uint8_t status;
} Ads1263Sample;

int32_t Ads1263_init(Ads1263 *device,
                     MCSPI_Handle spiHandle,
                     uint32_t spiChannel,
                     uint32_t resetGpioBase,
                     uint32_t resetGpioPin);
int32_t Ads1263_resetAndConfigure(Ads1263 *device);
int32_t Ads1263_configureAdc1(Ads1263 *device);
int32_t Ads1263_selectInput(Ads1263 *device, uint8_t channel);
int32_t Ads1263_start(Ads1263 *device);
int32_t Ads1263_stop(Ads1263 *device);
int32_t Ads1263_readAdc1(Ads1263 *device, Ads1263Sample *sample);
int32_t Ads1263_readRaw(Ads1263 *device, uint8_t rx[5]);

#endif
