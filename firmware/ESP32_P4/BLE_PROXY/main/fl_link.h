/*
 * Gateway side of the FieldLink BLE link protocol (spec v0.1, levels
 * A-C): sensor handshake, link-rate probing, sensor configuration, and
 * conversion of the sensor's DATA packets into ADS8688 stream frames.
 *
 * Level A sensors (raw 48-byte ADS8 frames, no handshake) are detected
 * from the byte stream and forwarded as-is.
 */

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "ads8688_stream.h"
#include "ble_uart.h"

typedef void (*fl_link_frame_cb_t)(const Ads8688StreamFrame *frame);

typedef struct {
    uint32_t rx_bytes;      /* bytes received over BLE */
    uint32_t frames;        /* frames handed to the output callback */
    uint32_t crc_failures;  /* packets/frames dropped for a bad CRC */
    uint32_t skipped_bytes; /* bytes discarded while searching for sync */
    uint32_t lost_frames;   /* sample_seq gaps + sensor-reported drops */
    uint32_t rx_overflow;   /* bytes dropped because the RX buffer was full */
} fl_link_stats_t;

typedef struct {
    const char *state;      /* static string, e.g. "streaming" */
    char level;             /* 'A', 'B', 'C', or '-' before detection */
    char name[33];          /* sensor-reported, untrusted */
    uint8_t device_id[8];
    uint8_t channels;
    uint8_t sample_format;
    uint32_t max_bps;
    uint32_t stable_bps;
    uint32_t scan_rate_hz;
    uint8_t frames_per_packet;
} fl_link_session_t;

/* Start the link task. `gateway_id` (8 bytes) is reported in HELLO_ACK. */
esp_err_t fl_link_start(fl_link_frame_cb_t on_frame, const uint8_t gateway_id[8]);

/* ble_uart callbacks: call from ble_uart_on_rx / on_event (BLE host task). */
void fl_link_feed(const uint8_t *data, size_t len);
void fl_link_on_ble_event(const ble_uart_evt_t *evt);

void fl_link_get_stats(fl_link_stats_t *out);
void fl_link_get_session(fl_link_session_t *out);
