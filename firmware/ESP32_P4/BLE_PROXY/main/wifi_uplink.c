/*
 * Wi-Fi station uplink. On the P4 the esp_wifi calls are forwarded to
 * the C6 over ESP-Hosted, which runs Wi-Fi and BLE side by side.
 */

#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "sdkconfig.h"

#include "wifi_uplink.h"

static const char *TAG = "wifi";

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t id, void *data)
{
    switch (id) {
    case WIFI_EVENT_STA_START:
        esp_wifi_connect();
        break;
    case WIFI_EVENT_STA_CONNECTED:
        ESP_LOGI(TAG, "associated with \"%s\"", CONFIG_FIELDLINK_WIFI_SSID);
        break;
    case WIFI_EVENT_STA_DISCONNECTED: {
        const wifi_event_sta_disconnected_t *d = data;
        ESP_LOGW(TAG, "disconnected (reason %d), retrying", d->reason);
        esp_wifi_connect();
        break;
    }
    default:
        break;
    }
}

esp_err_t wifi_uplink_start(void)
{
    if (CONFIG_FIELDLINK_WIFI_SSID[0] == '\0') {
        return ESP_OK;
    }

    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "esp_wifi_init");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                   wifi_event_handler, NULL),
                        TAG, "event handler");

    wifi_config_t cfg = {0};
    strlcpy((char *)cfg.sta.ssid, CONFIG_FIELDLINK_WIFI_SSID, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, CONFIG_FIELDLINK_WIFI_PASSWORD, sizeof(cfg.sta.password));

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "set_mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &cfg), TAG, "set_config");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "start");

    ESP_LOGI(TAG, "connecting to \"%s\"", CONFIG_FIELDLINK_WIFI_SSID);
    return ESP_OK;
}
