#include <stdint.h>
#include <stdio.h>
#include <string.h>

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

/* Raw RREG/WREG round trips: every TX and RX byte is logged unmodified. */
static void ads1263_log_xfer(const char *name, const uint8_t *tx, const uint8_t *rx, uint32_t n)
{
    char line[96];
    uint32_t i, pos = 0U;
    for (i = 0U; i < n; i++) {
        pos += (uint32_t)snprintf(&line[pos], sizeof(line) - pos, "%02X/%02X ", tx[i], rx[i]);
    }
    DebugP_log("ADS1263: REGTEST %s tx/rx: %s\n", name, line);
}

static void ads1263_register_test(Ads1263 *device)
{
    static const uint8_t muxValues[2] = {0x23U, 0x45U};
    uint8_t tx[9], rx[9];
    uint32_t pass, i;

    for (pass = 0U; pass < 3U; pass++) {
        tx[0] = ADS1263_CMD_RREG | ADS1263_REG_ID; tx[1] = 0x00U; tx[2] = 0x00U;
        memset(rx, 0, sizeof(rx));
        (void)Ads1263_transaction(device, tx, rx, 3U);
        ads1263_log_xfer("RREG ID   ", tx, rx, 3U);

        memset(tx, 0, sizeof(tx)); memset(rx, 0, sizeof(rx));
        tx[0] = ADS1263_CMD_RREG | ADS1263_REG_ID; tx[1] = 0x06U;
        (void)Ads1263_transaction(device, tx, rx, 9U);
        ads1263_log_xfer("RREG 00-06", tx, rx, 9U);

        for (i = 0U; i < 2U; i++) {
            tx[0] = ADS1263_CMD_WREG | ADS1263_REG_INPMUX; tx[1] = 0x00U; tx[2] = muxValues[i];
            memset(rx, 0, sizeof(rx));
            (void)Ads1263_transaction(device, tx, rx, 3U);
            ads1263_log_xfer(i == 0U ? "WREG MUX23" : "WREG MUX45", tx, rx, 3U);

            tx[0] = ADS1263_CMD_RREG | ADS1263_REG_INPMUX; tx[1] = 0x00U; tx[2] = 0x00U;
            memset(rx, 0, sizeof(rx));
            (void)Ads1263_transaction(device, tx, rx, 3U);
            ads1263_log_xfer("RREG MUX  ", tx, rx, 3U);
            DebugP_log("ADS1263: REGTEST INPMUX wrote %02X read %02X %s\n", muxValues[i], rx[2],
                       rx[2] == muxValues[i] ? "MATCH" : "MISMATCH");
        }
    }
    DebugP_log("ADS1263: REGTEST done spiErrors=%u\n", device->spiErrors);

#ifdef ADS1263_REGTEST_LOOP
    /* Scope mode: RREG ID (20 00 00) every 10 ms forever; trigger on CS falling. */
    for (pass = 0U; ; pass++) {
        tx[0] = ADS1263_CMD_RREG | ADS1263_REG_ID; tx[1] = 0x00U; tx[2] = 0x00U;
        memset(rx, 0, sizeof(rx));
        (void)Ads1263_transaction(device, tx, rx, 3U);
        if ((pass % 100U) == 0U) {
            ads1263_log_xfer("LOOP ID   ", tx, rx, 3U);
        }
        ClockP_usleep(10000U);
    }
#endif
}

void ads1263_scan_task(void *args)
{
    Ads1263 device;
    Ads1263Sample sample;
    Ads1263InitReport report;
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

    if (Ads1263_resetAndConfigure(&device, &report) != SystemP_SUCCESS) {
        DebugP_log("ADS1263: reset/configure failed\n");
    }
    DebugP_log("ADS1263: regs=[%02X %02X %02X %02X %02X %02X %02X]\n",
               report.regs[0], report.regs[1], report.regs[2], report.regs[3],
               report.regs[4], report.regs[5], report.regs[6]);
    DebugP_log("ADS1263: verify MODE0=%02X MODE1=%02X MODE2=%02X INPMUX=%02X (expect 00 00 8B 0A)\n",
               report.verify[0], report.verify[1], report.verify[2], report.verify[3]);
    ads1263_register_test(&device);

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
