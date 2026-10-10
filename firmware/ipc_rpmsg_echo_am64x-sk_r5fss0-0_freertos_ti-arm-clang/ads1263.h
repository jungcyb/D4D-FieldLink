#ifndef ADS1263_H
#define ADS1263_H

#include <stdint.h>
#include <drivers/mcspi.h>
#include <kernel/dpl/SystemP.h>

/* Register addresses */
#define ADS1263_REG_ID        (0x00U)
#define ADS1263_REG_POWER     (0x01U)
#define ADS1263_REG_INTERFACE (0x02U)
#define ADS1263_REG_MODE0     (0x03U)
#define ADS1263_REG_MODE1     (0x04U)
#define ADS1263_REG_MODE2     (0x05U)
#define ADS1263_REG_INPMUX    (0x06U)

/* Command bytes */
#define ADS1263_CMD_WREG      (0x40U)
#define ADS1263_CMD_RREG      (0x20U)
#define ADS1263_CMD_START1    (0x09U)
#define ADS1263_CMD_STOP      (0x0AU)

/* Differential mux values (AINx vs AINx+1) */
#define ADS1263_MUX_DIFF_0    (0x01U)  /* AIN0 vs AIN1 */
#define ADS1263_MUX_DIFF_1    (0x23U)  /* AIN2 vs AIN3 */
#define ADS1263_MUX_DIFF_2    (0x45U)  /* AIN4 vs AIN5 */
#define ADS1263_MUX_DIFF_3    (0x67U)  /* AIN6 vs AIN7 */

/* SDK-style device handle: MCSPI handle/channel (hardware CS, as in the
 * mcspi_loopback example) plus the RESET/DRDY GPIOs (gpio_led_blink style). */
typedef struct {
    MCSPI_Handle spiHandle;
    uint32_t     spiChannel;
    uint32_t     resetGpioBase;
    uint32_t     resetGpioPin;
    uint32_t     drdyGpioBase;
    uint32_t     drdyGpioPin;
    uint32_t     spiErrors;
} Ads1263;

typedef struct {
    int32_t  code;
    uint8_t  status;
} Ads1263Sample;

typedef struct {
    uint8_t regs[7];     /* ID..INPMUX read right after reset */
    uint8_t verify[4];   /* MODE0, MODE1, MODE2, INPMUX after the write */
} Ads1263InitReport;

int32_t Ads1263_init(Ads1263 *obj, MCSPI_Handle spiHandle, uint32_t spiChannel,
                     uint32_t resetBase, uint32_t resetPin,
                     uint32_t drdyBase, uint32_t drdyPin);
int32_t Ads1263_resetAndConfigure(Ads1263 *obj, Ads1263InitReport *report);
int32_t Ads1263_start(Ads1263 *obj);
int32_t Ads1263_stop(Ads1263 *obj);
int32_t Ads1263_selectInput(Ads1263 *obj, uint8_t mux);
int32_t Ads1263_readAdc1(Ads1263 *obj, Ads1263Sample *sample);
int32_t Ads1263_waitDrdy(Ads1263 *obj, uint32_t timeoutUs);
/* One command = one MCSPI transaction; hardware CS is low for the whole of it. */
int32_t Ads1263_transaction(Ads1263 *obj, uint8_t *tx, uint8_t *rx, uint32_t count);

#endif /* ADS1263_H */
