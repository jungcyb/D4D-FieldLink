/*
 * On-board Ethernet (internal EMAC + RMII PHY), DHCP, and SNTP. SNTP
 * starts on the first lease from either Ethernet or the Wi-Fi uplink.
 */

#pragma once

#include <stdbool.h>

#include "esp_err.h"

/* Requires esp_netif_init() and the default event loop. Returns once
 * the driver is started; the link and DHCP lease come up in the
 * background. */
esp_err_t eth_start(void);

/* True once SNTP has set the wall clock. */
bool eth_time_is_valid(void);
