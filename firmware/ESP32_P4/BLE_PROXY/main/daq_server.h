/*
 * ADS8688 network protocol v1 server (docs/PROTOCOL.md), so the
 * collector treats this proxy like an AM6442 board: UDP discovery,
 * TCP control, and LIVE_DATA / LIVE_DATA_V2 streaming.
 *
 * Recent records are kept in an in-memory (PSRAM) ring for ARCHIVE_INFO
 * and READ_BACKLOG replay, so the collector can fill gaps after a
 * network or server outage. The ring does not survive a reboot.
 */

#pragma once

#include "esp_err.h"

#include "ads8688_stream.h"

/* Load (or create) the board UUID from NVS and start the server task.
 * Requires NVS, esp_netif and the default event loop. */
esp_err_t daq_server_start(void);

/* Queue one validated frame for streaming. Stamps the receive time.
 * Safe from any task; drops the frame if the queue is full. */
void daq_server_publish(const Ads8688StreamFrame *frame);

/* The board's 16-byte UUID. Valid after daq_server_start(). */
const uint8_t *daq_server_uuid(void);
