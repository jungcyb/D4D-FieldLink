#include <stdint.h>

#include <kernel/dpl/AddrTranslateP.h>
#include <kernel/dpl/ClockP.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/SystemP.h>

#include "ads1263.h"
#include "ti_drivers_config.h"
#include "ti_drivers_open_close.h"
#include "ti_board_open_close.h"

#define ADS1263_SCAN_CHANNELS (4U)
#define ADS1263_DRDY_TIMEOUT_US (2000U)
#define ADS1263_SCAN_PERIOD_US  (100000U)

static const uint8_t gDiffMux[ADS1263_SCAN_CHANNELS] = {
    ADS1263_MUX_DIFF_0,
    ADS1263_MUX_DIFF_1,
    ADS1263_MUX_DIFF_2,
    ADS1263_MUX_DIFF_3
};

void ads1263_scan_task(void *args)
{
    Ads1263 device;
    Ads1263Sample sample;
    uint32_t resetBase;
    uint32_t drdyBase;
    uint32_t ch;
    int32_t status;

    (void)args;

    Drivers_open();
    Board_driversOpen();

    if (gMcspiHandle[CONFIG_ADS1263_MCSPI] == NULL) {
        DebugP_log("ADS1263: SPI handle not opened\n");
        return;
    }

    resetBase = (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_RESET_BASE_ADDR);
    drdyBase  = (uint32_t)AddrTranslateP_getLocalAddr(ADS1263_DRDY_BASE_ADDR);

    status = Ads1263_init(&device,
                          gMcspiHandle[CONFIG_ADS1263_MCSPI],
                          gConfigAds1263McspiChCfg[0U].chNum,
                          resetBase, ADS1263_RESET_PIN,
                          drdyBase, ADS1263_DRDY_PIN);
    if (status != SystemP_SUCCESS) {
        DebugP_log("ADS1263: init failed\n");
        return;
    }

    if (Ads1263_resetAndConfigure(&device) != SystemP_SUCCESS) {
        DebugP_log("ADS1263: reset/configure failed\n");
    }

    for (;;) {
        for (ch = 0U; ch < ADS1263_SCAN_CHANNELS; ch++) {
            if (Ads1263_selectInput(&device, gDiffMux[ch]) != SystemP_SUCCESS) {
                DebugP_log("ADS1263: ch%u mux write failed\n", ch);
                continue;
            }
            if (Ads1263_waitDrdy(&device, ADS1263_DRDY_TIMEOUT_US) != SystemP_SUCCESS) {
                DebugP_log("ADS1263: ch%u DRDY timeout\n", ch);
                continue;
            }
            if (Ads1263_readAdc1(&device, &sample) != SystemP_SUCCESS) {
                DebugP_log("ADS1263: ch%u read failed\n", ch);
                continue;
            }
            DebugP_log("ADS1263: ch%u status=0x%02X code=%d\n",
                       ch, sample.status, sample.code);
        }
        ClockP_usleep(ADS1263_SCAN_PERIOD_US);
    }
}
