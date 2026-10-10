/*
 * SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Unlicense OR CC0-1.0
 *
 * FieldLink BLE proxy. The sensor connects over BLE (the radio is the
 * on-board ESP32-C6, driven through ESP-Hosted) and talks the FieldLink
 * BLE link protocol on the BLE UART characteristics (fl_link.c). Its
 * data is turned into ADS8688 frames and served over Ethernet with the
 * same discovery and TCP protocol as the AM6442 board
 * (docs/PROTOCOL.md), so the collector picks this board up unchanged.
 */

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#if CONFIG_ESP_HOSTED_ENABLED
#include "esp_hosted.h"
#endif

#include "ble_uart.h"
#include "daq_server.h"
#include "eth.h"
#include "fl_link.h"
#include "wifi_uplink.h"

/* Advertising layout (spec §3): the service UUID must sit in the PRIMARY
 * packet, because sensors scan passively and never see the scan
 * response. ble_uart's default puts it only in the scan response.
 *
 *   primary (<= BLE_UART_ADV_DATA_MAX = 28; Flags are prepended):
 *     Shortened Local Name "FL-XXXX"      1 + 1 + 7  = 9
 *     Complete 128-bit UUID list          1 + 1 + 16 = 18
 *   scan response (<= 31):
 *     Complete Local Name "<prefix>-XXXX"
 *
 * Kept static: ble_uart re-reads them whenever it restarts advertising. */
static uint8_t s_adv_data[9 + 18];
static uint8_t s_scan_rsp[2 + BLE_UART_DEVICE_NAME_MAX];
static size_t s_scan_rsp_len;

static void build_adv(const char *name, const uint8_t *mac)
{
    uint8_t *p = s_adv_data;
    *p++ = 8;
    *p++ = 0x08;                        /* Shortened Local Name */
    snprintf((char *)p, 8, "FL-%02X%02X", mac[4], mac[5]);
    p += 7;
    *p++ = 17;
    *p++ = 0x07;                        /* Complete list of 128-bit UUIDs */
    memcpy(p, ble_uart_service_uuid.bytes, 16);

    size_t n = strlen(name);
    s_scan_rsp[0] = n + 1;
    s_scan_rsp[1] = 0x09;               /* Complete Local Name */
    memcpy(&s_scan_rsp[2], name, n);
    s_scan_rsp_len = n + 2;
}

static const char *TAG = "app";

#define STATS_PERIOD_MS 5000

#if CONFIG_FIELDLINK_BLE_ENCRYPTED
#define BLE_ENCRYPTED true
#else
#define BLE_ENCRYPTED false
#endif

static void ble_uart_on_rx(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0) {
        return;
    }
    fl_link_feed(data, len);
}

/* Lifecycle / link-state event sink. Runs on the BLE host task —
 * keep it short, never call ble_uart_close()/uninstall() from here.
 *
 * For production code: gate any sensitive TX on
 * BLE_UART_EVT_LINK_SECURE (encrypted+authenticated) instead of just
 * "connected"; ble_uart_is_connected() returns true while the link is
 * still plaintext during the pairing window. */
static void ble_uart_on_event(const ble_uart_evt_t *e)
{
    fl_link_on_ble_event(e);

    switch (e->id) {
    case BLE_UART_EVT_CONNECTED: {
        const uint8_t *b = e->connected.peer.bytes;
        ESP_LOGI(TAG,
                 "evt: connected peer=%02x:%02x:%02x:%02x:%02x:%02x type=%u",
                 b[0], b[1], b[2], b[3], b[4], b[5], e->connected.peer.type);
        break;
    }
    case BLE_UART_EVT_DISCONNECTED:
        ESP_LOGI(TAG, "evt: disconnected reason=0x%x",
                 e->disconnected.reason);
        break;
    case BLE_UART_EVT_SUBSCRIBED:
        ESP_LOGI(TAG, "evt: %ssubscribed",
                 e->subscribed.subscribed ? "" : "un");
        break;
    case BLE_UART_EVT_LINK_SECURE:
        ESP_LOGI(TAG, "evt: link_secure enc=%d auth=%d bond=%d ks=%u",
                 e->link_secure.encrypted, e->link_secure.authenticated,
                 e->link_secure.bonded, e->link_secure.key_size);
        break;
    case BLE_UART_EVT_PASSKEY_DISPLAY:
        ESP_LOGI(TAG, "evt: passkey=%06" PRIu32, e->passkey.passkey);
        break;
    case BLE_UART_EVT_PASSKEY_REQUEST:
        /* Fires only when cfg.security.io_cap is KEYBOARD_ONLY or
         * KEYBOARD_DISPLAY (this example leaves io_cap at AUTO →
         * DisplayOnly, so it should not fire). For a real keypad
         * product, prompt the user for the 6 digits the central
         * displayed and feed them in:
         *
         *     ble_uart_passkey_reply(digits);
         *
         * See PORTING.md §5.6.1 for the full pattern. */
        ESP_LOGW(TAG, "evt: passkey entry requested — no UI wired in this "
                      "example (see PORTING.md §5.6.1)");
        break;
    case BLE_UART_EVT_NUMERIC_COMPARE:
        /* Fires only when cfg.security.io_cap is DISPLAY_YES_NO or
         * KEYBOARD_DISPLAY (likewise dormant in this example). For a
         * product with a yes/no control, surface the digits to the
         * user and resolve the comparison:
         *
         *     ble_uart_compare_reply(user_says_match);
         *
         * See PORTING.md §5.6.1. */
        ESP_LOGW(TAG, "evt: numeric compare %06" PRIu32
                      " — no yes/no UI wired (see PORTING.md §5.6.1)",
                 e->numeric_compare.passkey);
        break;
    case BLE_UART_EVT_PAIRING_FAILED:
        ESP_LOGW(TAG, "evt: pairing failed reason=0x%x",
                 e->pairing_failed.reason);
        break;
    case BLE_UART_EVT_CLOSED:
        /* Only after ble_uart_close_async(). This example does not use
         * close_async; do not ble_uart_uninstall() here — defer to an
         * app task (PORTING.md §5.3.2). Kept for -Wswitch. */
        if (e->closed.status == BLE_UART_OK) {
            ESP_LOGI(TAG, "evt: closed (async-close succeeded)");
        } else {
            ESP_LOGW(TAG, "evt: closed async-close failed status=%d",
                     e->closed.status);
        }
        break;
    }
}

#if CONFIG_ESP_HOSTED_ENABLED
/* Bring up the SDIO link to the C6 and its BT controller. Must run
 * before ble_uart_install(), whose nimble_port_init() talks HCI to it. */
static esp_err_t coprocessor_bt_start(void)
{
    if (esp_hosted_connect_to_slave() != ESP_OK) {
        ESP_LOGE(TAG, "ESP-Hosted: no link to the C6 co-processor");
        return ESP_FAIL;
    }

    esp_hosted_coprocessor_fwver_t fw;
    if (esp_hosted_get_coprocessor_fwversion(&fw) == ESP_OK) {
        ESP_LOGI(TAG, "C6 slave firmware %" PRIu32 ".%" PRIu32 ".%" PRIu32,
                 fw.major1, fw.minor1, fw.patch1);
    }

    esp_err_t err = esp_hosted_bt_controller_init();
    if (err == ESP_OK) {
        err = esp_hosted_bt_controller_enable();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "C6 BT controller start failed (%s); the slave "
                      "firmware may lack BT support", esp_err_to_name(err));
    }
    return err;
}
#endif

static esp_err_t ble_start(void)
{
#if CONFIG_ESP_HOSTED_ENABLED
    ESP_RETURN_ON_ERROR(coprocessor_bt_start(), TAG, "co-processor");
#endif

    /* Device name = "<prefix>-XXXX" with XXXX = last two MAC bytes.
     * If esp_read_mac() fails, mac stays zero and the suffix degrades
     * to "0000" — log so the operator notices uniqueness was lost. */
    uint8_t mac[6] = {0};
    esp_err_t mac_err = esp_read_mac(mac, ESP_MAC_BT);
    if (mac_err != ESP_OK) {
        /* No BT MAC on a host-only chip (P4): the radio is the C6. Use
         * the base MAC, which also ends the network hostname. */
        mac_err = esp_read_mac(mac, ESP_MAC_BASE);
    }
    if (mac_err != ESP_OK) {
        ESP_LOGW(TAG, "esp_read_mac failed (%s); device name suffix will be 0000",
                 esp_err_to_name(mac_err));
    }
    char name[BLE_UART_DEVICE_NAME_MAX + 1];
    snprintf(name, sizeof(name), "%s-%02X%02X",
             CONFIG_BLE_UART_DEVICE_NAME_PREFIX, mac[4], mac[5]);
    build_adv(name, mac);

    int rc = ble_uart_install(&(ble_uart_config_t){
        .encrypted      = BLE_ENCRYPTED,
        .device_name    = name,
        .adv_data          = s_adv_data,
        .adv_data_len      = sizeof(s_adv_data),
        .scan_rsp_data     = s_scan_rsp,
        .scan_rsp_data_len = s_scan_rsp_len,
        .ble_uart_on_rx = ble_uart_on_rx,
        .on_event       = ble_uart_on_event,
    });
    if (rc != BLE_UART_OK) {
        ESP_LOGE(TAG, "ble_uart_install rc=%d", rc);
        return ESP_FAIL;
    }

    /* List bonded peers already on flash. Replace the log with
     * `ble_uart_clear_bonds()` to wipe them at boot (e.g. when a
     * "factory reset" GPIO is held). */
    size_t total = 0;
    ble_uart_addr_t list[8];
    rc = ble_uart_get_bonded_peers(list, sizeof(list) / sizeof(list[0]), &total);
    if (rc == 0) {
        ESP_LOGI(TAG, "%u peer(s) currently bonded", (unsigned)total);
        size_t shown = total < sizeof(list) / sizeof(list[0])
                       ? total : sizeof(list) / sizeof(list[0]);
        for (size_t i = 0; i < shown; i++) {
            const uint8_t *b = list[i].bytes;
            ESP_LOGI(TAG, "  [%u] %02x:%02x:%02x:%02x:%02x:%02x type=%u",
                     (unsigned)i,
                     b[0], b[1], b[2], b[3], b[4], b[5], list[i].type);
        }
    }

    rc = ble_uart_open();
    if (rc != BLE_UART_OK) {
        ESP_LOGE(TAG, "ble_uart_open rc=%d", rc);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "advertising as \"%s\"", name);
    return ESP_OK;
}

void app_main(void)
{
    /* NVS holds the BLE bond store and the board UUID. */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(eth_start());
    ESP_ERROR_CHECK(daq_server_start());

    /* Gateway id in HELLO_ACK = first half of the board UUID. */
    ESP_ERROR_CHECK(fl_link_start(daq_server_publish, daq_server_uuid()));

    /* Keep the network side up even if BLE fails, so the board stays
     * discoverable and the failure is visible in STATUS. */
    if (ble_start() != ESP_OK) {
        ESP_LOGE(TAG, "BLE unavailable; serving network without a data source");
    }

    /* After ble_start(): on the P4 the Wi-Fi calls ride the same
     * ESP-Hosted link to the C6, which that brings up. */
    esp_err_t wifi_err = wifi_uplink_start();
    if (wifi_err != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi uplink failed (%s)", esp_err_to_name(wifi_err));
    }

    fl_link_stats_t last = {0};
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(STATS_PERIOD_MS));
        fl_link_stats_t now;
        fl_link_get_stats(&now);
        if (now.rx_bytes != last.rx_bytes) {
            ESP_LOGI(TAG, "ble rx=%" PRIu32 " B frames=%" PRIu32 " lost=%" PRIu32
                          " crc_fail=%" PRIu32 " skipped=%" PRIu32 " B (last %d s)",
                     now.rx_bytes - last.rx_bytes, now.frames - last.frames,
                     now.lost_frames - last.lost_frames,
                     now.crc_failures - last.crc_failures,
                     now.skipped_bytes - last.skipped_bytes,
                     STATS_PERIOD_MS / 1000);
        }
        last = now;
    }
}
