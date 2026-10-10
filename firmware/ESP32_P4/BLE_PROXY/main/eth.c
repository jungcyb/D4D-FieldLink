/*
 * On-board Ethernet bring-up, based on the ESP-IDF ethernet/basic
 * example: internal EMAC with its default RMII pinout and the generic
 * IEEE 802.3 PHY driver. SNTP starts on the first DHCP lease.
 */

#include <sys/time.h>

#include "esp_eth.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "sdkconfig.h"

#include "eth.h"

/* Anything before 2024-01-01 means the clock was never set. */
#define ETH_MIN_VALID_EPOCH 1704067200

static const char *TAG = "eth";

static void eth_event_handler(void *arg, esp_event_base_t base,
                              int32_t id, void *data)
{
    switch (id) {
    case ETHERNET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "link up");
        break;
    case ETHERNET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "link down");
        break;
    default:
        break;
    }
}

static void got_ip_handler(void *arg, esp_event_base_t base,
                           int32_t id, void *data)
{
    static bool s_sntp_started;
    const ip_event_got_ip_t *event = data;

    ESP_LOGI(TAG, "got IP " IPSTR " mask " IPSTR " gw " IPSTR,
             IP2STR(&event->ip_info.ip), IP2STR(&event->ip_info.netmask),
             IP2STR(&event->ip_info.gw));

    if (!s_sntp_started && CONFIG_FIELDLINK_SNTP_SERVER[0] != '\0') {
        esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_FIELDLINK_SNTP_SERVER);
        if (esp_netif_sntp_init(&cfg) == ESP_OK) {
            s_sntp_started = true;
            ESP_LOGI(TAG, "SNTP started (%s)", CONFIG_FIELDLINK_SNTP_SERVER);
        }
    }
}

esp_err_t eth_start(void)
{
    eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
    phy_config.phy_addr = CONFIG_FIELDLINK_ETH_PHY_ADDR;
    phy_config.reset_gpio_num = CONFIG_FIELDLINK_ETH_PHY_RST_GPIO;

    eth_esp32_emac_config_t emac_config = ETH_ESP32_EMAC_DEFAULT_CONFIG();
    emac_config.smi_gpio.mdc_num = CONFIG_FIELDLINK_ETH_MDC_GPIO;
    emac_config.smi_gpio.mdio_num = CONFIG_FIELDLINK_ETH_MDIO_GPIO;

    esp_eth_mac_t *mac = esp_eth_mac_new_esp32(&emac_config, &mac_config);
    if (mac == NULL) {
        ESP_LOGE(TAG, "create MAC failed");
        return ESP_FAIL;
    }
    esp_eth_phy_t *phy = esp_eth_phy_new_generic(&phy_config);
    if (phy == NULL) {
        ESP_LOGE(TAG, "create PHY failed");
        mac->del(mac);
        return ESP_FAIL;
    }

    esp_eth_handle_t handle = NULL;
    esp_eth_config_t config = ETH_DEFAULT_CONFIG(mac, phy);
    esp_err_t err = esp_eth_driver_install(&config, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "driver install failed (%s)", esp_err_to_name(err));
        mac->del(mac);
        phy->del(phy);
        return err;
    }

    esp_netif_config_t netif_cfg = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&netif_cfg);
    ESP_ERROR_CHECK(esp_netif_attach(netif, esp_eth_new_netif_glue(handle)));

    ESP_ERROR_CHECK(esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID,
                                               eth_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP,
                                               got_ip_handler, NULL));
    /* Same handling for the optional Wi-Fi uplink (wifi_uplink.c). */
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                               got_ip_handler, NULL));
    return esp_eth_start(handle);
}

bool eth_time_is_valid(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec >= ETH_MIN_VALID_EPOCH;
}
