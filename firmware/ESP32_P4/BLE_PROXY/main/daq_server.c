/*
 * ADS8688 network protocol v1 (docs/PROTOCOL.md), ported from the
 * AM6442 daemon (board/ads8688d.py): UDP discovery on 8764, TCP
 * control + streaming on 8765. All TCP multi-byte fields are
 * big-endian; the 48-byte frame is forwarded untouched (little-endian).
 *
 * One task owns every socket and polls the live-frame queue between
 * select() calls, so no locking is needed beyond the FreeRTOS queue.
 */

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/time.h>

#include "esp_check.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include "sdkconfig.h"

#include "anomaly.h"
#include "archive.h"
#include "ble_uart.h"
#include "daq_server.h"
#include "eth.h"
#include "fl_link.h"

#define PROTOCOL_VERSION    1
#define NET_HEADER_SIZE     12
#define CLIENT_RX_MAX       512
#define LIVE_QUEUE_LEN      128
#define POLL_MS             10
#define ACQUIRING_WINDOW_US (2 * 1000 * 1000)

#define MODEL               "ESP32-P4-BLE-PROXY"
#define RATE_GROUP_ID       "ble.scan"
#define RATE_GROUP_LABEL    "BLE %u채널 공통"
#define FRAME_SIZE          sizeof(Ads8688StreamFrame)

/* Only the first EXPOSED_CHANNELS slots are advertised and filtered; the
 * wire frame keeps all 8 slots (the collector expects 8) and the rest
 * are pinned to mid-scale (0 V). */
#define EXPOSED_CHANNELS    CONFIG_FIELDLINK_DAQ_EXPOSED_CHANNELS
#define MEDIAN_WINDOW       CONFIG_FIELDLINK_DAQ_MEDIAN_WINDOW
#define AVG_WINDOW          CONFIG_FIELDLINK_DAQ_MOVING_AVG_WINDOW
#define MID_SCALE_CODE      32768

#define MSG_HELLO           0x0001
#define MSG_STATUS          0x0002
#define MSG_ACQ_START       0x0003
#define MSG_ACQ_STOP        0x0004
#define MSG_SET_RATE        0x0005
#define MSG_STREAM_START    0x0006
#define MSG_STREAM_STOP     0x0007
#define MSG_ARCHIVE_INFO    0x0008
#define MSG_READ_BACKLOG    0x0009
#define MSG_READ_BACKLOG_V2 0x000a
#define MSG_STREAM_START_V2 0x000b
#define MSG_SET_RATE_GROUP  0x000c
#define MSG_LIVE_DATA       0x0100
#define MSG_ARCHIVE_DATA    0x0101
#define MSG_ARCHIVE_DATA_V2 0x0102
#define MSG_LIVE_DATA_V2    0x0103
#define MSG_RESPONSE        0x8000
#define MSG_ERROR           0xffff

#define MAX_BACKLOG_PAGE    2000  /* same page cap as the AM6442 daemon */

typedef struct {
    uint64_t unix_ns;
    Ads8688StreamFrame frame;
} live_item_t;

typedef struct {
    int fd;
    uint8_t streaming;  /* 0 = off, 1 = LIVE_DATA, 2 = LIVE_DATA_V2 */
    char addr[16];
    uint8_t rx[CLIENT_RX_MAX];
    size_t rx_len;
    uint8_t *tx;
    size_t tx_len;
    /* READ_BACKLOG in progress: records are queued as the TX buffer
     * drains, then the completion response is sent. */
    bool backlog;
    uint16_t backlog_type;
    uint32_t backlog_request_id;
    uint64_t backlog_after;
    uint64_t backlog_next;
    uint64_t backlog_end;
    uint64_t backlog_last;
    uint32_t backlog_returned;
    bool backlog_had_records;
    uint64_t backlog_earliest;
} client_t;

typedef struct {
    char *buf;
    size_t cap;
    size_t len;
} jbuf_t;

static const char *TAG = "daq_server";

static client_t s_clients[CONFIG_FIELDLINK_DAQ_MAX_CLIENTS];
static QueueHandle_t s_live_queue;
static int s_listen_fd = -1;
static int s_udp_fd = -1;

static uint8_t s_uuid[16];
static char s_uuid_str[37];
static char s_hostname[32];

static uint32_t s_scan_rate = CONFIG_FIELDLINK_DAQ_DEFAULT_SCAN_RATE;
/* record_id = boot_count << RECORD_BOOT_SHIFT | per-boot counter, so ids
 * keep increasing across reboots like the AM6442's persistent ids. The
 * collector derives batch ids from them and the dashboard drops batch
 * ids it has already seen, so restarting at 1 would discard every frame
 * until the old ids were passed. */
#define RECORD_BOOT_SHIFT   40
static uint64_t s_next_record_id = 1;
static uint32_t s_frames_total;
static uint32_t s_gaps_total;
static volatile uint32_t s_dropped_total;
static bool s_have_sequence;
static uint32_t s_last_sequence;
static int64_t s_last_frame_us;

/* Per exposed channel: sliding median, then a moving average of the
 * median output. Server-task only. */
static uint16_t s_median_hist[EXPOSED_CHANNELS][MEDIAN_WINDOW];
static uint8_t s_median_count;
static uint8_t s_median_head;
static uint16_t s_avg_hist[EXPOSED_CHANNELS][AVG_WINDOW];
static uint32_t s_avg_sum[EXPOSED_CHANNELS];
static uint8_t s_avg_count;
static uint8_t s_avg_head;

/* Server-task only. */
static char s_json[4096];
static uint8_t s_udp_buf[1400];

/* ----- helpers -------------------------------------------------------- */

static void put_be16(uint8_t *p, uint16_t v)
{
    p[0] = v >> 8;
    p[1] = v;
}

static void put_be32(uint8_t *p, uint32_t v)
{
    put_be16(p, v >> 16);
    put_be16(p + 2, v);
}

static void put_be64(uint8_t *p, uint64_t v)
{
    put_be32(p, v >> 32);
    put_be32(p + 4, v);
}

static uint16_t get_be16(const uint8_t *p)
{
    return (uint16_t)(p[0] << 8 | p[1]);
}

static uint32_t get_be32(const uint8_t *p)
{
    return (uint32_t)get_be16(p) << 16 | get_be16(p + 2);
}

static uint64_t get_be64(const uint8_t *p)
{
    return (uint64_t)get_be32(p) << 32 | get_be32(p + 4);
}

static void jb_printf(jbuf_t *b, const char *fmt, ...)
{
    if (b->len >= b->cap) {
        return;
    }
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(b->buf + b->len, b->cap - b->len, fmt, ap);
    va_end(ap);
    /* On truncation len runs past cap, which jb_ok() reports. */
    b->len += n > 0 ? (size_t)n : 0;
}

static bool jb_ok(const jbuf_t *b)
{
    return b->len < b->cap;
}

/* JSON string literal, for text that came from the sensor. */
static void jb_string(jbuf_t *b, const char *str)
{
    jb_printf(b, "\"");
    for (const unsigned char *c = (const unsigned char *)str; *c; c++) {
        if (*c == '"' || *c == '\\') {
            jb_printf(b, "\\%c", *c);
        } else if (*c < 0x20) {
            jb_printf(b, "\\u%04x", *c);
        } else {
            jb_printf(b, "%c", *c);
        }
    }
    jb_printf(b, "\"");
}

static void jb_channel_ids(jbuf_t *b)
{
    jb_printf(b, "[");
    for (unsigned ch = 0; ch < EXPOSED_CHANNELS; ch++) {
        jb_printf(b, "%s\"CH%u\"", ch ? "," : "", ch);
    }
    jb_printf(b, "]");
}

/* Same schema as channel_capabilities() / discovery_capabilities() in
 * ads8688d.py. `compact` selects the array form used in UDP discovery. */
static void jb_channel_caps(jbuf_t *b, bool compact)
{
    jb_printf(b, "{\"schemaVersion\":1,\"channelCount\":%u,\"channels\":[",
              EXPOSED_CHANNELS);
    for (unsigned ch = 0; ch < EXPOSED_CHANNELS; ch++) {
        if (compact) {
            jb_printf(b, "%s[\"CH%u\",\"BLE CH%u\",\"BLE\",\"CH%u\",%" PRIu32
                         ",\"V\",\"" RATE_GROUP_ID "\",true]",
                      ch ? "," : "", ch, ch, ch, s_scan_rate);
        } else {
            jb_printf(b, "%s{\"id\":\"CH%u\",\"label\":\"BLE CH%u\","
                         "\"adc\":\"BLE\",\"adcChannel\":\"CH%u\","
                         "\"sampleRateHz\":%" PRIu32 ",\"inputUnit\":\"V\","
                         "\"rateGroupId\":\"" RATE_GROUP_ID "\","
                         "\"streamAvailable\":true}",
                      ch ? "," : "", ch, ch, ch, s_scan_rate);
        }
    }
    jb_printf(b, "],\"sampleRateGroups\":[");
    if (compact) {
        jb_printf(b, "[\"" RATE_GROUP_ID "\",\"" RATE_GROUP_LABEL "\",", EXPOSED_CHANNELS);
        jb_channel_ids(b);
        jb_printf(b, ",%" PRIu32 ",false,null,null,null]", s_scan_rate);
    } else {
        jb_printf(b, "{\"id\":\"" RATE_GROUP_ID "\",\"label\":\"" RATE_GROUP_LABEL
                     "\",\"channelIds\":", EXPOSED_CHANNELS);
        jb_channel_ids(b);
        jb_printf(b, ",\"currentHz\":%" PRIu32 ",\"writable\":false}", s_scan_rate);
    }
    jb_printf(b, "]}");
}

/* Same fields as RecordRing.info() in ads8688d.py; the ring is a single
 * in-memory "segment". */
static void jb_archive_info(jbuf_t *b)
{
    archive_info_t a;
    archive_get_info(&a);
    if (a.count) {
        jb_printf(b, "{\"earliest_record_id\":%" PRIu64 ",\"latest_record_id\":%" PRIu64
                     ",\"segments\":1", a.earliest, a.latest);
    } else {
        jb_printf(b, "{\"earliest_record_id\":null,\"latest_record_id\":null,\"segments\":0");
    }
    jb_printf(b, ",\"stored_bytes\":%u,\"free_bytes\":%u,\"reserve_bytes\":0,"
                 "\"storage\":\"memory\",\"capacity_records\":%" PRIu32 "}",
              (unsigned)(a.count * a.record_bytes),
              (unsigned)((a.capacity - a.count) * a.record_bytes), a.capacity);
}

static void jb_anomaly(jbuf_t *b)
{
    anomaly_config_t cfg;
    anomaly_get_config(&cfg);
    jb_printf(b, "{\"method\":\"rms_sta_lta\",\"state\":\"%s\",\"short_tau_s\":%.3f,"
                 "\"long_tau_s\":%.1f,\"warn_ratio\":%.2f,\"alarm_ratio\":%.2f,"
                 "\"rms_floor_v\":%.6f,\"channels\":[",
              anomaly_state_name(anomaly_overall()), cfg.short_tau_s, cfg.long_tau_s,
              cfg.warn_ratio, cfg.alarm_ratio, cfg.rms_floor_v);
    for (unsigned ch = 0; ch < anomaly_channels(); ch++) {
        anomaly_channel_t a;
        anomaly_get_channel(ch, &a);
        jb_printf(b, "%s{\"id\":\"CH%u\",\"state\":\"%s\",\"rms_short_v\":%.6f,"
                     "\"rms_long_v\":%.6f,\"ratio\":%.3f,\"changed_unix_ms\":%" PRIu64
                     ",\"events\":%" PRIu32 "}",
                  ch ? "," : "", ch, anomaly_state_name(a.state), a.rms_short_v,
                  a.rms_long_v, a.ratio, a.changed_unix_ms, a.events);
    }
    jb_printf(b, "]}");
}

/* ----- client I/O ----------------------------------------------------- */

static void client_close(client_t *c, const char *reason)
{
    if (c->fd < 0) {
        return;
    }
    ESP_LOGI(TAG, "client disconnected: %s (%s)", c->addr, reason);
    close(c->fd);
    c->fd = -1;
    c->streaming = 0;
    c->rx_len = 0;
    c->tx_len = 0;
    c->backlog = false;
}

static void client_send(client_t *c, uint16_t type, uint32_t request_id,
                        const void *payload, size_t len)
{
    if (c->fd < 0) {
        return;
    }
    if (c->tx_len + NET_HEADER_SIZE + len > CONFIG_FIELDLINK_DAQ_CLIENT_TX_BUF) {
        client_close(c, "slow client");
        return;
    }
    uint8_t *h = c->tx + c->tx_len;
    put_be32(h, len);
    put_be16(h + 4, PROTOCOL_VERSION);
    put_be16(h + 6, type);
    put_be32(h + 8, request_id);
    memcpy(h + NET_HEADER_SIZE, payload, len);
    c->tx_len += NET_HEADER_SIZE + len;
}

static void client_flush(client_t *c)
{
    while (c->fd >= 0 && c->tx_len > 0) {
        int n = send(c->fd, c->tx, c->tx_len, MSG_DONTWAIT);
        if (n > 0) {
            memmove(c->tx, c->tx + n, c->tx_len - n);
            c->tx_len -= n;
        } else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return;
        } else {
            client_close(c, n == 0 ? "send returned 0" : strerror(errno));
        }
    }
}

static void respond_error(client_t *c, uint32_t request_id, const char *error)
{
    char body[128];
    int n = snprintf(body, sizeof(body), "{\"error\":\"%s\"}", error);
    client_send(c, MSG_ERROR, request_id, body, (size_t)n < sizeof(body) ? n : sizeof(body) - 1);
}

static void respond_json(client_t *c, uint16_t type, uint32_t request_id,
                         const jbuf_t *b)
{
    if (!jb_ok(b)) {
        respond_error(c, request_id, "response too large");
        return;
    }
    client_send(c, type | MSG_RESPONSE, request_id, b->buf, b->len);
}

/* ----- backlog replay ------------------------------------------------- */

static bool archive_capacity_ok(void)
{
    archive_info_t a;
    archive_get_info(&a);
    return a.enabled;
}

/* Queue backlog records while at most half the TX buffer is used (the
 * rest is headroom for live frames), and send the completion response
 * once the page is done. */
static void backlog_pump(client_t *c)
{
    if (c->fd < 0 || !c->backlog) {
        return;
    }
    bool v2 = c->backlog_type == MSG_READ_BACKLOG_V2;
    size_t prefix = v2 ? 16 : 8;
    uint8_t msg[16 + FRAME_SIZE];

    while (c->backlog_next <= c->backlog_end &&
           c->tx_len + NET_HEADER_SIZE + prefix + FRAME_SIZE <= CONFIG_FIELDLINK_DAQ_CLIENT_TX_BUF / 2) {
        uint64_t unix_ns;
        Ads8688StreamFrame f;
        if (!archive_read(c->backlog_next, &unix_ns, &f)) {
            /* Overwritten while paging: skip to the oldest record left. */
            archive_info_t a;
            archive_get_info(&a);
            if (a.count && c->backlog_next < a.earliest) {
                c->backlog_next = a.earliest;
                continue;
            }
            c->backlog_end = c->backlog_next - 1;
            break;
        }
        put_be64(msg, c->backlog_next);
        if (v2) {
            put_be64(msg + 8, unix_ns);
        }
        memcpy(msg + prefix, &f, FRAME_SIZE);
        client_send(c, v2 ? MSG_ARCHIVE_DATA_V2 : MSG_ARCHIVE_DATA, c->backlog_request_id,
                    msg, prefix + FRAME_SIZE);
        c->backlog_last = c->backlog_next++;
        c->backlog_returned++;
    }
    if (c->fd < 0 || c->backlog_next <= c->backlog_end) {
        return;
    }

    archive_info_t a;
    archive_get_info(&a);
    jbuf_t b = {.buf = s_json, .cap = sizeof(s_json)};
    jb_printf(&b, "{\"returned\":%" PRIu32 ",\"last_record_id\":%" PRIu64 ",\"latest_record_id\":",
              c->backlog_returned, c->backlog_last);
    jb_printf(&b, a.count ? "%" PRIu64 : "null", a.latest);
    jb_printf(&b, ",\"more\":%s,\"earliest_record_id\":",
              a.count && c->backlog_last < a.latest ? "true" : "false");
    jb_printf(&b, c->backlog_had_records ? "%" PRIu64 : "null", c->backlog_earliest);
    jb_printf(&b, ",\"truncated\":%s}",
              c->backlog_had_records && c->backlog_after + 1 < c->backlog_earliest ? "true" : "false");
    c->backlog = false;
    respond_json(c, c->backlog_type, c->backlog_request_id, &b);
}

/* ----- commands ------------------------------------------------------- */

static void handle_command(client_t *c, uint16_t type, uint32_t request_id,
                           const uint8_t *payload, size_t len)
{
    jbuf_t b = {.buf = s_json, .cap = sizeof(s_json)};

    switch (type) {
    case MSG_HELLO:
        jb_printf(&b, "{\"protocol_version\":%d,\"uuid\":\"%s\",\"model\":\"" MODEL
                      "\",\"capabilities\":[\"live_stream\"%s%s],"
                      "\"channel_capabilities\":",
                  PROTOCOL_VERSION, s_uuid_str,
                  archive_capacity_ok() ? ",\"local_ring\",\"backlog_replay\"" : "",
                  eth_time_is_valid() ? ",\"timestamped_stream\"" : "");
        jb_channel_caps(&b, false);
        jb_printf(&b, "}");
        respond_json(c, type, request_id, &b);
        break;

    case MSG_STATUS: {
        fl_link_stats_t link;
        fl_link_session_t sensor;
        fl_link_get_stats(&link);
        fl_link_get_session(&sensor);
        int64_t now_us = esp_timer_get_time();
        bool acquiring = s_last_frame_us != 0 &&
                         now_us - s_last_frame_us < ACQUIRING_WINDOW_US;

        jb_printf(&b, "{\"uuid\":\"%s\",\"hostname\":\"%s\",\"acquiring\":%s,"
                      "\"scan_rate_hz\":%" PRIu32 ",\"channel_capabilities\":",
                  s_uuid_str, s_hostname, acquiring ? "true" : "false", s_scan_rate);
        jb_channel_caps(&b, false);
        jb_printf(&b, ",\"frames_total\":%" PRIu32 ",\"invalid_total\":%" PRIu32
                      ",\"sequence_gaps_total\":%" PRIu32 ",\"dropped_total\":%" PRIu32
                      ",\"uptime_seconds\":%.3f,\"archive\":",
                  s_frames_total, link.crc_failures, s_gaps_total,
                  s_dropped_total, now_us / 1e6);
        jb_archive_info(&b);
        jb_printf(&b, ",\"anomaly\":");
        jb_anomaly(&b);
        jb_printf(&b, ",\"ble\":{\"connected\":%s,\"rx_bytes\":%" PRIu32
                      ",\"skipped_bytes\":%" PRIu32 ",\"lost_frames\":%" PRIu32
                      ",\"rx_overflow_bytes\":%" PRIu32 "}",
                  ble_uart_is_connected() ? "true" : "false",
                  link.rx_bytes, link.skipped_bytes, link.lost_frames, link.rx_overflow);
        jb_printf(&b, ",\"sensor\":{\"state\":\"%s\",\"level\":\"%c\",\"name\":",
                  sensor.state, sensor.level);
        jb_string(&b, sensor.name);
        jb_printf(&b, ",\"device_id\":\"%02x%02x%02x%02x%02x%02x%02x%02x\""
                      ",\"channels\":%u,\"sample_format\":%u,\"scan_rate_hz\":%" PRIu32
                      ",\"frames_per_packet\":%u,\"max_bps\":%" PRIu32
                      ",\"stable_bps\":%" PRIu32 "}",
                  sensor.device_id[0], sensor.device_id[1], sensor.device_id[2],
                  sensor.device_id[3], sensor.device_id[4], sensor.device_id[5],
                  sensor.device_id[6], sensor.device_id[7], sensor.channels,
                  sensor.sample_format, sensor.scan_rate_hz, sensor.frames_per_packet,
                  sensor.max_bps, sensor.stable_bps);
        jb_printf(&b, ",\"system\":{\"idf\":\"%s\",\"free_heap_bytes\":%" PRIu32
                      ",\"time_synced\":%s}}",
                  esp_get_idf_version(), esp_get_free_heap_size(),
                  eth_time_is_valid() ? "true" : "false");
        respond_json(c, type, request_id, &b);
        break;
    }

    case MSG_STREAM_START:
        c->streaming = 1;
        jb_printf(&b, "{\"streaming\":true}");
        respond_json(c, type, request_id, &b);
        break;

    case MSG_STREAM_START_V2:
        c->streaming = 2;
        jb_printf(&b, "{\"streaming\":true,\"timestamps\":\"unix_ns\"}");
        respond_json(c, type, request_id, &b);
        break;

    case MSG_STREAM_STOP:
        c->streaming = 0;
        jb_printf(&b, "{\"streaming\":false}");
        respond_json(c, type, request_id, &b);
        break;

    case MSG_ARCHIVE_INFO:
        jb_archive_info(&b);
        respond_json(c, type, request_id, &b);
        break;

    case MSG_READ_BACKLOG:
    case MSG_READ_BACKLOG_V2: {
        if (len != 12) {
            respond_error(c, request_id, "READ_BACKLOG payload must be uint64,uint32");
            break;
        }
        if (c->backlog) {
            respond_error(c, request_id, "READ_BACKLOG already in progress");
            break;
        }
        archive_info_t a;
        archive_get_info(&a);
        uint64_t after = get_be64(payload);
        uint32_t limit = MIN(get_be32(payload + 8), MAX_BACKLOG_PAGE);
        /* Like RecordRing.read_after(): the next `limit` records after
         * `after`, starting at the oldest one still kept. */
        uint64_t next = a.count ? MAX(after + 1, a.earliest) : after + 1;
        c->backlog = true;
        c->backlog_type = type;
        c->backlog_request_id = request_id;
        c->backlog_after = after;
        c->backlog_next = next;
        c->backlog_end = a.count && limit && next <= a.latest ? MIN(next + limit - 1, a.latest)
                                                             : next - 1;
        c->backlog_last = after;
        c->backlog_returned = 0;
        c->backlog_had_records = a.count > 0;
        c->backlog_earliest = a.earliest;
        backlog_pump(c);
        break;
    }

    case MSG_ACQ_START:
    case MSG_ACQ_STOP:
    case MSG_SET_RATE:
    case MSG_SET_RATE_GROUP:
        respond_error(c, request_id, "acquisition control is not supported by the BLE proxy");
        break;

    default: {
        char error[48];
        snprintf(error, sizeof(error), "unknown message type %u", type);
        respond_error(c, request_id, error);
        break;
    }
    }
}

static void client_read(client_t *c)
{
    int n = recv(c->fd, c->rx + c->rx_len, sizeof(c->rx) - c->rx_len, MSG_DONTWAIT);
    if (n == 0) {
        client_close(c, "peer closed");
        return;
    }
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK) {
            client_close(c, strerror(errno));
        }
        return;
    }
    c->rx_len += n;

    while (c->fd >= 0 && c->rx_len >= NET_HEADER_SIZE) {
        uint32_t size = get_be32(c->rx);
        uint16_t version = get_be16(c->rx + 4);
        uint16_t type = get_be16(c->rx + 6);
        uint32_t request_id = get_be32(c->rx + 8);

        if (size > CLIENT_RX_MAX - NET_HEADER_SIZE) {
            client_close(c, "oversized message");
            return;
        }
        size_t total = NET_HEADER_SIZE + size;
        if (c->rx_len < total) {
            return;
        }
        if (version != PROTOCOL_VERSION) {
            respond_error(c, request_id, "unsupported protocol version");
        } else {
            handle_command(c, type, request_id, c->rx + NET_HEADER_SIZE, size);
        }
        if (c->fd < 0) {
            return;
        }
        memmove(c->rx, c->rx + total, c->rx_len - total);
        c->rx_len -= total;
    }
}

static void accept_client(void)
{
    struct sockaddr_in addr;
    socklen_t addr_len = sizeof(addr);
    int fd = accept(s_listen_fd, (struct sockaddr *)&addr, &addr_len);
    if (fd < 0) {
        return;
    }

    client_t *c = NULL;
    for (size_t i = 0; i < CONFIG_FIELDLINK_DAQ_MAX_CLIENTS; i++) {
        if (s_clients[i].fd < 0) {
            c = &s_clients[i];
            break;
        }
    }
    char ip[16];
    inet_ntoa_r(addr.sin_addr, ip, sizeof(ip));
    if (c == NULL) {
        ESP_LOGW(TAG, "rejecting %s: %d clients already connected",
                 ip, CONFIG_FIELDLINK_DAQ_MAX_CLIENTS);
        close(fd);
        return;
    }

    int one = 1;
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));

    c->fd = fd;
    c->streaming = 0;
    c->rx_len = 0;
    c->tx_len = 0;
    c->backlog = false;
    strlcpy(c->addr, ip, sizeof(c->addr));
    ESP_LOGI(TAG, "client connected: %s:%u", ip, ntohs(addr.sin_port));
}

/* ----- UDP discovery -------------------------------------------------- */

static void handle_discovery(void)
{
    uint8_t req[64];
    struct sockaddr_in from;
    socklen_t from_len = sizeof(from);
    int n = recvfrom(s_udp_fd, req, sizeof(req), MSG_DONTWAIT,
                     (struct sockaddr *)&from, &from_len);
    if (n != 16 || memcmp(req, "A8DQ", 4) != 0) {
        return;
    }
    uint16_t version = get_be16(req + 4);
    if (version != 1 && version != 2) {
        return;
    }

    size_t host_len = strlen(s_hostname);
    size_t model_len = strlen(MODEL);
    size_t header_len = version == 2 ? 38 : 36;
    uint8_t *p = s_udp_buf;

    memcpy(p, "A8DR", 4);
    put_be16(p + 4, version);
    put_be16(p + 6, 0);                 /* status */
    memcpy(p + 8, req + 8, 8);          /* nonce, echoed verbatim */
    memcpy(p + 16, s_uuid, 16);
    put_be16(p + 32, CONFIG_FIELDLINK_DAQ_TCP_PORT);
    p[34] = host_len;
    p[35] = model_len;
    memcpy(p + header_len, s_hostname, host_len);
    memcpy(p + header_len + host_len, MODEL, model_len);
    size_t total = header_len + host_len + model_len;

    if (version == 2) {
        jbuf_t b = {
            .buf = (char *)p + total,
            .cap = sizeof(s_udp_buf) - total,
        };
        jb_channel_caps(&b, true);
        if (!jb_ok(&b)) {
            ESP_LOGE(TAG, "discovery capabilities do not fit in one datagram");
            return;
        }
        put_be16(p + 36, b.len);
        total += b.len;
    }

    sendto(s_udp_fd, p, total, 0, (struct sockaddr *)&from, from_len);
}

/* ----- live stream ---------------------------------------------------- */

/* Median of the last MEDIAN_WINDOW samples (fewer while the window
 * fills); an even count averages the two middle values. */
static uint16_t median_of(const uint16_t *hist, uint8_t count)
{
    uint16_t sorted[MEDIAN_WINDOW];
    for (uint8_t i = 0; i < count; i++) {
        uint16_t v = hist[i];
        uint8_t j = i;
        for (; j > 0 && sorted[j - 1] > v; j--) {
            sorted[j] = sorted[j - 1];
        }
        sorted[j] = v;
    }
    if (count & 1) {
        return sorted[count / 2];
    }
    return (uint16_t)(((uint32_t)sorted[count / 2 - 1] + sorted[count / 2] + 1) / 2);
}

static void filter_reset(void)
{
    s_median_count = 0;
    s_median_head = 0;
    s_avg_count = 0;
    s_avg_head = 0;
    memset(s_avg_sum, 0, sizeof(s_avg_sum));
}

/* Mean of the last AVG_WINDOW medians (fewer while the window fills),
 * kept as a running sum. Advances the window for channel `ch`; the
 * caller bumps s_avg_head/s_avg_count once per frame. */
static uint16_t moving_average(unsigned ch, uint16_t value)
{
    if (s_avg_count == AVG_WINDOW) {
        s_avg_sum[ch] -= s_avg_hist[ch][s_avg_head];
    }
    s_avg_hist[ch][s_avg_head] = value;
    s_avg_sum[ch] += value;
    uint8_t count = s_avg_count < AVG_WINDOW ? s_avg_count + 1 : AVG_WINDOW;
    return (uint16_t)((s_avg_sum[ch] + count / 2) / count);
}

/* Filter the exposed channels in place (median, then moving average),
 * blank the rest, and re-sign. */
static void filter_frame(Ads8688StreamFrame *f)
{
    for (unsigned ch = 0; ch < EXPOSED_CHANNELS; ch++) {
        s_median_hist[ch][s_median_head] = f->samples[ch];
    }
    s_median_head = (s_median_head + 1) % MEDIAN_WINDOW;
    if (s_median_count < MEDIAN_WINDOW) {
        s_median_count++;
    }
    for (unsigned ch = 0; ch < ADS8688_STREAM_CHANNELS; ch++) {
        f->samples[ch] = ch < EXPOSED_CHANNELS
                             ? moving_average(ch, median_of(s_median_hist[ch], s_median_count))
                             : MID_SCALE_CODE;
    }
    s_avg_head = (s_avg_head + 1) % AVG_WINDOW;
    if (s_avg_count < AVG_WINDOW) {
        s_avg_count++;
    }
    f->crc32 = Ads8688Stream_crc32(f, offsetof(Ads8688StreamFrame, crc32));
}

static void drain_live_queue(void)
{
    live_item_t item;
    uint8_t v1[8 + FRAME_SIZE];
    uint8_t v2[16 + FRAME_SIZE];

    while (xQueueReceive(s_live_queue, &item, 0) == pdTRUE) {
        Ads8688StreamFrame *f = &item.frame;

        /* A new sensor session restarts the sequence; don't let the
         * previous session's samples leak into the filters. */
        if (!s_have_sequence || f->sequence <= s_last_sequence ||
            f->scanRateHz != s_scan_rate) {
            filter_reset();
            anomaly_reset();
        }
        /* Anomaly detection sees the raw samples: the filters below
         * would hide the vibration energy it measures. */
        anomaly_update(f, item.unix_ns / 1000000ULL);
        filter_frame(f);

        if (s_have_sequence && f->sequence != s_last_sequence + 1) {
            s_gaps_total += f->sequence - s_last_sequence - 1;
        }
        s_have_sequence = true;
        s_last_sequence = f->sequence;
        s_scan_rate = f->scanRateHz;
        s_last_frame_us = esp_timer_get_time();

        uint64_t record_id = s_next_record_id++;
        s_frames_total++;
        archive_append(record_id, item.unix_ns, f);

        put_be64(v1, record_id);
        memcpy(v1 + 8, f, FRAME_SIZE);
        put_be64(v2, record_id);
        put_be64(v2 + 8, item.unix_ns);
        memcpy(v2 + 16, f, FRAME_SIZE);

        for (size_t i = 0; i < CONFIG_FIELDLINK_DAQ_MAX_CLIENTS; i++) {
            client_t *c = &s_clients[i];
            if (c->fd < 0 || c->streaming == 0) {
                continue;
            }
            if (c->streaming == 2) {
                client_send(c, MSG_LIVE_DATA_V2, 0, v2, sizeof(v2));
            } else {
                client_send(c, MSG_LIVE_DATA, 0, v1, sizeof(v1));
            }
        }
    }
}

void daq_server_publish(const Ads8688StreamFrame *frame)
{
    live_item_t item;
    struct timeval tv;

    gettimeofday(&tv, NULL);
    item.unix_ns = (uint64_t)tv.tv_sec * 1000000000ULL + (uint64_t)tv.tv_usec * 1000ULL;
    item.frame = *frame;
    if (s_live_queue == NULL || xQueueSend(s_live_queue, &item, 0) != pdTRUE) {
        s_dropped_total++;
    }
}

const uint8_t *daq_server_uuid(void)
{
    return s_uuid;
}

/* ----- task + setup --------------------------------------------------- */

static void server_task(void *arg)
{
    for (;;) {
        fd_set rfds, wfds;
        FD_ZERO(&rfds);
        FD_ZERO(&wfds);
        FD_SET(s_listen_fd, &rfds);
        FD_SET(s_udp_fd, &rfds);
        int max_fd = MAX(s_listen_fd, s_udp_fd);
        for (size_t i = 0; i < CONFIG_FIELDLINK_DAQ_MAX_CLIENTS; i++) {
            client_t *c = &s_clients[i];
            if (c->fd < 0) {
                continue;
            }
            FD_SET(c->fd, &rfds);
            if (c->tx_len > 0) {
                FD_SET(c->fd, &wfds);
            }
            max_fd = MAX(max_fd, c->fd);
        }

        struct timeval tv = {.tv_sec = 0, .tv_usec = POLL_MS * 1000};
        int ready = select(max_fd + 1, &rfds, &wfds, NULL, &tv);
        if (ready < 0) {
            ESP_LOGE(TAG, "select failed: %s", strerror(errno));
            vTaskDelay(pdMS_TO_TICKS(POLL_MS));
            continue;
        }
        if (ready > 0) {
            if (FD_ISSET(s_udp_fd, &rfds)) {
                handle_discovery();
            }
            for (size_t i = 0; i < CONFIG_FIELDLINK_DAQ_MAX_CLIENTS; i++) {
                client_t *c = &s_clients[i];
                if (c->fd >= 0 && FD_ISSET(c->fd, &rfds)) {
                    client_read(c);
                }
            }
            if (FD_ISSET(s_listen_fd, &rfds)) {
                accept_client();
            }
        }

        /* Batch every frame that arrived during this poll into one send
         * per client. */
        drain_live_queue();
        for (size_t i = 0; i < CONFIG_FIELDLINK_DAQ_MAX_CLIENTS; i++) {
            backlog_pump(&s_clients[i]);
            client_flush(&s_clients[i]);
        }
    }
}

static esp_err_t load_identity(void)
{
    nvs_handle_t nvs;
    ESP_RETURN_ON_ERROR(nvs_open("fieldlink", NVS_READWRITE, &nvs), TAG, "nvs_open");

    size_t len = sizeof(s_uuid);
    if (nvs_get_blob(nvs, "uuid", s_uuid, &len) != ESP_OK || len != sizeof(s_uuid)) {
        /* Random (version 4) UUID, created once and kept across reboots. */
        esp_fill_random(s_uuid, sizeof(s_uuid));
        s_uuid[6] = (s_uuid[6] & 0x0f) | 0x40;
        s_uuid[8] = (s_uuid[8] & 0x3f) | 0x80;
        esp_err_t err = nvs_set_blob(nvs, "uuid", s_uuid, sizeof(s_uuid));
        if (err == ESP_OK) {
            err = nvs_commit(nvs);
        }
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "could not persist UUID (%s); it will change on reboot",
                     esp_err_to_name(err));
        }
    }

    uint32_t boots = 0;
    nvs_get_u32(nvs, "boots", &boots);
    boots++;
    esp_err_t err = nvs_set_u32(nvs, "boots", boots);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "could not persist boot count (%s); record ids may repeat",
                 esp_err_to_name(err));
    }
    s_next_record_id = ((uint64_t)boots << RECORD_BOOT_SHIFT) + 1;
    nvs_close(nvs);

    const uint8_t *u = s_uuid;
    snprintf(s_uuid_str, sizeof(s_uuid_str),
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7],
             u[8], u[9], u[10], u[11], u[12], u[13], u[14], u[15]);
    return ESP_OK;
}

static int open_socket(int type, int port)
{
    int fd = socket(AF_INET, type, type == SOCK_STREAM ? IPPROTO_TCP : IPPROTO_UDP);
    if (fd < 0) {
        return -1;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    if (type == SOCK_DGRAM) {
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
    }

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(port),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 ||
        (type == SOCK_STREAM && listen(fd, CONFIG_FIELDLINK_DAQ_MAX_CLIENTS) != 0)) {
        ESP_LOGE(TAG, "bind/listen on port %d failed: %s", port, strerror(errno));
        close(fd);
        return -1;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    return fd;
}

esp_err_t daq_server_start(void)
{
    ESP_RETURN_ON_ERROR(load_identity(), TAG, "identity");

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_ETH);
    snprintf(s_hostname, sizeof(s_hostname), "%s-%02x%02x",
             CONFIG_FIELDLINK_DAQ_HOSTNAME_PREFIX, mac[4], mac[5]);

    for (size_t i = 0; i < CONFIG_FIELDLINK_DAQ_MAX_CLIENTS; i++) {
        s_clients[i].fd = -1;
        s_clients[i].tx = malloc(CONFIG_FIELDLINK_DAQ_CLIENT_TX_BUF);
        ESP_RETURN_ON_FALSE(s_clients[i].tx, ESP_ERR_NO_MEM, TAG, "client tx buffer");
    }

    s_live_queue = xQueueCreate(LIVE_QUEUE_LEN, sizeof(live_item_t));
    ESP_RETURN_ON_FALSE(s_live_queue, ESP_ERR_NO_MEM, TAG, "live queue");

    size_t ring_bytes = (size_t)CONFIG_FIELDLINK_DAQ_ARCHIVE_KB * 1024;
    void *ring = ring_bytes ? heap_caps_malloc(ring_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) : NULL;
    if (ring_bytes && !ring) {
        ESP_LOGW(TAG, "no %u KiB of PSRAM for the backlog ring; backlog replay disabled",
                 (unsigned)CONFIG_FIELDLINK_DAQ_ARCHIVE_KB);
    }
    archive_init(ring, ring ? ring_bytes : 0, EXPOSED_CHANNELS);
    if (ring) {
        archive_info_t a;
        archive_get_info(&a);
        ESP_LOGI(TAG, "backlog ring: %" PRIu32 " records (%u min at 100 Hz)", a.capacity,
                 (unsigned)(a.capacity / 100 / 60));
    }

    anomaly_config_t anomaly_cfg = {
        .short_tau_s = CONFIG_FIELDLINK_ANOMALY_SHORT_TAU_MS / 1000.0f,
        .long_tau_s = CONFIG_FIELDLINK_ANOMALY_LONG_TAU_S,
        .warn_ratio = CONFIG_FIELDLINK_ANOMALY_WARN_RATIO_X100 / 100.0f,
        .alarm_ratio = CONFIG_FIELDLINK_ANOMALY_ALARM_RATIO_X100 / 100.0f,
        .rms_floor_v = CONFIG_FIELDLINK_ANOMALY_RMS_FLOOR_UV / 1e6f,
    };
    anomaly_init(&anomaly_cfg, EXPOSED_CHANNELS);

    s_listen_fd = open_socket(SOCK_STREAM, CONFIG_FIELDLINK_DAQ_TCP_PORT);
    s_udp_fd = open_socket(SOCK_DGRAM, CONFIG_FIELDLINK_DAQ_DISCOVERY_PORT);
    ESP_RETURN_ON_FALSE(s_listen_fd >= 0 && s_udp_fd >= 0, ESP_FAIL, TAG, "sockets");

    ESP_RETURN_ON_FALSE(xTaskCreate(server_task, "daq_server", 6144, NULL, 5, NULL) == pdPASS,
                        ESP_ERR_NO_MEM, TAG, "task");

    ESP_LOGI(TAG, "uuid=%s hostname=%s tcp=%d udp=%d first_record=%" PRIu64, s_uuid_str,
             s_hostname, CONFIG_FIELDLINK_DAQ_TCP_PORT, CONFIG_FIELDLINK_DAQ_DISCOVERY_PORT,
             s_next_record_id);
    return ESP_OK;
}
