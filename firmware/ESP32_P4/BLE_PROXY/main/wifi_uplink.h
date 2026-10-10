/*
 * Optional Wi-Fi station uplink through the ESP32-C6 co-processor
 * (ESP-Hosted), for benches without an Ethernet cable. The DAQ server
 * listens on every interface, so it is reachable over whichever link
 * gets an address.
 */

#pragma once

#include "esp_err.h"

/* No-op when CONFIG_FIELDLINK_WIFI_SSID is empty. Requires esp_netif,
 * the default event loop, and (on P4) the ESP-Hosted link to be up. */
esp_err_t wifi_uplink_start(void);
