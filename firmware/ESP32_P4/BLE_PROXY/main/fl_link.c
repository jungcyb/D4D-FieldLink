/*
 * FieldLink BLE link protocol, gateway side (spec v0.1, levels A-C).
 *
 * BLE callbacks only copy bytes and events into a stream buffer and a
 * queue; one task owns the parser, the session state machine, the
 * timeouts and every packet sent back to the sensor, so the BLE host
 * task never blocks on protocol work.
 *
 * Session flow (gateway view):
 *   connect -> WAIT_HELLO -> HELLO_ACK -> [level C] WAIT_LINK_INFO ->
 *   PROBING (max, then stable) -> WAIT_CONFIG_ACK -> WAIT_START ->
 *   STREAMING. A level A sensor skips all of it: raw ADS8 frames in the
 *   byte stream put the session straight into STREAMING_A.
 */

#include <assert.h>
#include <inttypes.h>
#include <stdbool.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "sdkconfig.h"

#include "fl_link.h"

/* ----- protocol constants (spec §4, §6) ------------------------------ */

#define FL_HDR              10
#define FL_CRC              4
#define FL_MAX_PAYLOAD      1024
#define FL_VERSION          1

#define FL_F_CRC            0x01

#define T_HELLO             0x01
#define T_HELLO_ACK         0x02
#define T_LINK_INFO         0x03
#define T_PROBE_START       0x10
#define T_PROBE_DATA        0x11
#define T_PROBE_END         0x12
#define T_PROBE_RESULT      0x13
#define T_CONFIG            0x20
#define T_CONFIG_ACK        0x21
#define T_START             0x22
#define T_STOP              0x23
#define T_RESULT            0x24
#define T_DATA              0x30
#define T_ACK               0x31
#define T_HEARTBEAT         0x40
#define T_ERROR             0x7f

#define CAP_CRC             (1u << 0)
#define CAP_PROBE           (1u << 1)
#define CAP_CONFIG          (1u << 2)
#define CAP_TIMESTAMP       (1u << 3)

#define DEVICE_CLASS_SENSOR 0x01
#define GATEWAY_CLASS       0x80
#define GATEWAY_FW_VERSION  0x0100

#define HELLO_ST_OK         0
#define HELLO_ST_VERSION    1
#define HELLO_ST_CLASS      2
#define HELLO_ST_FORMAT     4

#define ERR_BAD_CRC         1
#define ERR_UNSUPPORTED     2
#define ERR_BAD_LENGTH      3

/* ----- timing and rate policy (spec §7, §9) -------------------------- */

#define HELLO_TIMEOUT_US        (5000 * 1000LL)
#define REQUEST_TIMEOUT_US      (1000 * 1000LL)
#define REQUEST_RETRIES         3
#define REJECT_LINGER_US        (200 * 1000LL)
#define LINK_INFO_WAIT_US       (1000 * 1000LL)
#define CLOSE_WAIT_US           (2000 * 1000LL)
#define PROBE_MAX_MS            2000
#define PROBE_STABLE_MS         10000
#define PROBE_GRACE_US          (2000 * 1000LL)
#define PROBE_ATTEMPTS          5
#define LOSS_WINDOW_US          (10 * 1000 * 1000LL)
#define QUEUE_RISE_LIMIT        10
#define DEFAULT_HEARTBEAT_MS    1000
#define DATA_FIXED_BYTES        34      /* header 10 + DATA head 20 + CRC 4 */
#define PACKETS_PER_SECOND_MIN  10      /* caps batching latency at 100 ms */
#define CONFIG_STEP_DOWNS       4       /* re-CONFIGs when the sensor rounds up */

#define RX_STREAM_SIZE      8192
#define PARSE_BUF_SIZE      2048
#define EVT_QUEUE_LEN       8
#define POLL_MS             10

typedef enum {
    ST_IDLE,
    ST_WAIT_HELLO,
    ST_REJECTED,
    ST_WAIT_LINK_INFO,
    ST_PROBING,
    ST_WAIT_CONFIG_ACK,
    ST_WAIT_START,
    ST_WAIT_STOP,
    ST_STREAMING,
    ST_STREAMING_A,
    ST_CLOSING,
} link_state_t;

static const char *const k_state_names[] = {
    [ST_IDLE] = "idle",
    [ST_WAIT_HELLO] = "wait_hello",
    [ST_REJECTED] = "rejected",
    [ST_WAIT_LINK_INFO] = "wait_link_info",
    [ST_PROBING] = "probing",
    [ST_WAIT_CONFIG_ACK] = "wait_config_ack",
    [ST_WAIT_START] = "wait_start",
    [ST_WAIT_STOP] = "wait_stop",
    [ST_STREAMING] = "streaming",
    [ST_STREAMING_A] = "streaming_raw",
    [ST_CLOSING] = "closing",
};

typedef struct {
    uint8_t id;
    uint8_t mode;               /* 0 = max, 1 = fixed rate */
    uint32_t target_bps;
    uint32_t packets;
    uint32_t bytes;
    uint32_t first_bytes;
    uint32_t gaps;
    uint32_t corrupt;
    uint32_t crc_base;
    uint32_t last_seq;
    bool have_seq;
    int64_t t_first;
    int64_t t_last;
} probe_t;

typedef struct {
    link_state_t state;
    int64_t deadline;
    char level;

    bool have_peer;
    ble_addr_t peer;

    /* HELLO */
    uint8_t device_id[8];
    uint8_t sample_format;
    uint8_t channels;
    uint8_t max_fpp;
    uint32_t caps;
    uint32_t rate_min;
    uint32_t rate_max;
    uint32_t rate_cur;
    char name[33];
    uint16_t max_packet;

    /* pending request, resent on timeout */
    uint8_t pend_type;
    uint8_t pend_payload[16];
    uint16_t pend_len;
    uint8_t retries;

    /* rate negotiation */
    probe_t probe;
    uint8_t probe_seq_id;
    uint8_t attempt;
    uint32_t max_bps;
    uint32_t stable_bps;

    /* rate budget for CONFIG, kept for re-CONFIG after the sensor rounds */
    uint64_t budget;
    uint32_t frame_bytes;
    uint8_t f_max;
    uint8_t config_tries;

    /* applied configuration */
    uint32_t scan_rate;
    uint8_t fpp;
    uint16_t heartbeat_ms;

    /* streaming health */
    int64_t last_rx_us;
    bool have_sample_seq;
    uint32_t next_sample_seq;
    int64_t window_start_us;
    uint32_t window_rx;
    uint32_t window_lost;
    bool have_hb;
    uint16_t last_queue_used;
    uint8_t queue_rise;
    uint32_t last_dropped;
} session_t;

static const char *TAG = "fl_link";

static fl_link_frame_cb_t s_on_frame;
static uint8_t s_gateway_id[8];
static StreamBufferHandle_t s_rx;
static QueueHandle_t s_evt_q;

static session_t s;
static uint16_t s_tx_seq;
static uint8_t s_buf[PARSE_BUF_SIZE];
static size_t s_len;
static fl_link_stats_t s_stats;

/* ----- little-endian helpers ------------------------------------------ */

static uint16_t rd16(const uint8_t *p)
{
    return (uint16_t)(p[0] | p[1] << 8);
}

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)rd16(p) | (uint32_t)rd16(p + 2) << 16;
}

static uint64_t rd64(const uint8_t *p)
{
    return (uint64_t)rd32(p) | (uint64_t)rd32(p + 4) << 32;
}

static void wr16(uint8_t *p, uint16_t v)
{
    p[0] = v;
    p[1] = v >> 8;
}

static void wr32(uint8_t *p, uint32_t v)
{
    wr16(p, v);
    wr16(p + 2, v >> 16);
}

/* ----- BLE link helpers ----------------------------------------------- */

static bool conn_lookup(struct ble_gap_conn_desc *desc)
{
    return s.have_peer && ble_gap_conn_find_by_addr(&s.peer, desc) == 0;
}

static uint16_t link_max_packet(void)
{
    struct ble_gap_conn_desc desc;
    uint16_t mtu = conn_lookup(&desc) ? ble_att_mtu(desc.conn_handle) : 23;
    uint16_t max = mtu > 3 ? mtu - 3 : 20;
    return max < FL_HDR + FL_MAX_PAYLOAD + FL_CRC ? max : FL_HDR + FL_MAX_PAYLOAD + FL_CRC;
}

static void set_state(link_state_t state, int64_t timeout_us)
{
    s.state = state;
    s.deadline = timeout_us ? esp_timer_get_time() + timeout_us : 0;
}

static void link_disconnect(const char *why)
{
    struct ble_gap_conn_desc desc;

    ESP_LOGW(TAG, "disconnecting sensor: %s", why);
    if (conn_lookup(&desc)) {
        ble_gap_terminate(desc.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    } else {
        ESP_LOGE(TAG, "connection handle not found; cannot disconnect");
    }
    set_state(ST_CLOSING, CLOSE_WAIT_US);
}

/* ----- sending -------------------------------------------------------- */

static void send_packet(uint8_t type, const uint8_t *payload, uint16_t len)
{
    uint8_t pkt[FL_HDR + 32 + FL_CRC];

    assert(len <= 32);
    pkt[0] = 'F';
    pkt[1] = 'L';
    pkt[2] = FL_VERSION;
    pkt[3] = type;
    pkt[4] = FL_F_CRC;      /* control packets always carry a CRC */
    pkt[5] = 0;
    wr16(pkt + 6, s_tx_seq++);
    wr16(pkt + 8, len);
    if (len) {
        memcpy(pkt + FL_HDR, payload, len);
    }
    wr32(pkt + FL_HDR + len, Ads8688Stream_crc32(pkt, FL_HDR + len));

    int rc = ble_uart_tx(pkt, FL_HDR + len + FL_CRC);
    if (rc != BLE_UART_OK) {
        ESP_LOGW(TAG, "tx type 0x%02x failed rc=%d", type, rc);
    }
}

static void send_error(uint8_t code, uint8_t for_type, uint16_t for_seq)
{
    uint8_t p[5] = {code, for_type, 0, 0, 0};
    wr16(p + 2, for_seq);
    send_packet(T_ERROR, p, sizeof(p));
}

/* Send a request that expects a reply, and resend it on timeout. */
static void send_request(uint8_t type, const uint8_t *payload, uint16_t len,
                         link_state_t wait_state)
{
    s.pend_type = type;
    s.pend_len = len;
    if (len) {
        memcpy(s.pend_payload, payload, len);
    }
    s.retries = 0;
    send_packet(type, payload, len);
    set_state(wait_state, REQUEST_TIMEOUT_US);
}

static void send_link_info(void)
{
    struct ble_gap_conn_desc desc;
    uint8_t p[12] = {0};

    if (conn_lookup(&desc)) {
        uint8_t tx_phy = 0, rx_phy = 0;
        ble_gap_read_le_phy(desc.conn_handle, &tx_phy, &rx_phy);
        wr16(p, ble_att_mtu(desc.conn_handle));
        p[2] = tx_phy;
        p[3] = rx_phy;
        wr16(p + 4, desc.conn_itvl);
        wr16(p + 6, desc.conn_latency);
        wr16(p + 8, desc.supervision_timeout);
        /* p[10..11] max_tx_octets: not exposed by the host API, sent as 0. */
        ESP_LOGI(TAG, "gateway link: mtu=%u phy=%u/%u itvl=%.2f ms latency=%u timeout=%u ms",
                 rd16(p), tx_phy, rx_phy, desc.conn_itvl * 1.25,
                 desc.conn_latency, desc.supervision_timeout * 10);
    }
    send_packet(T_LINK_INFO, p, sizeof(p));
}

/* ----- negotiation (spec §7) ------------------------------------------ */

static void configure_and_start(void);

static void start_probe(uint8_t mode, uint32_t target_bps, uint16_t duration_ms)
{
    uint8_t p[10];
    uint16_t payload_bytes = s.max_packet > 20 ? s.max_packet - 20 : 1;

    memset(&s.probe, 0, sizeof(s.probe));
    s.probe.id = ++s.probe_seq_id;
    s.probe.mode = mode;
    s.probe.target_bps = target_bps;
    s.probe.crc_base = s_stats.crc_failures;

    p[0] = s.probe.id;
    p[1] = mode;
    wr16(p + 2, payload_bytes);
    wr32(p + 4, target_bps);
    wr16(p + 8, duration_ms);
    send_packet(T_PROBE_START, p, sizeof(p));
    set_state(ST_PROBING, duration_ms * 1000LL + PROBE_GRACE_US);

    if (mode == 0) {
        ESP_LOGI(TAG, "probe %u: max rate, %u ms, %u B payload",
                 s.probe.id, duration_ms, payload_bytes);
    } else {
        ESP_LOGI(TAG, "probe %u: stable at %" PRIu32 " bps, %u ms (attempt %u/%d)",
                 s.probe.id, target_bps, duration_ms, s.attempt, PROBE_ATTEMPTS);
    }
}

static void begin_negotiation(void)
{
    s.max_packet = link_max_packet();
    s.max_bps = 0;
    s.stable_bps = 0;
    if (s.caps & CAP_PROBE) {
        start_probe(0, 0, PROBE_MAX_MS);
    } else {
        configure_and_start();
    }
}

/* `end` is NULL when PROBE_END never arrived. */
static void finish_probe(const uint8_t *end)
{
    probe_t *pr = &s.probe;
    uint32_t sent = end ? rd32(end + 4) : 0;
    uint32_t busy = end ? rd32(end + 12) : 0;
    uint32_t lost = pr->gaps;
    uint32_t corrupt = pr->corrupt + (s_stats.crc_failures - pr->crc_base);
    uint32_t bps = 0;

    if (sent > pr->packets && sent - pr->packets > lost) {
        lost = sent - pr->packets;
    }
    /* Rate over first..last arrival, so the first packet's bytes are
     * excluded: N packets span N-1 intervals. */
    if (pr->packets >= 2 && pr->t_last > pr->t_first) {
        bps = (uint32_t)((uint64_t)(pr->bytes - pr->first_bytes) * 8 * 1000000 /
                         (uint64_t)(pr->t_last - pr->t_first));
    }

    bool pass;
    if (pr->mode == 0) {
        pass = pr->packets > 0;
    } else {
        pass = end != NULL && lost == 0 && corrupt == 0 && busy == 0 &&
               (uint64_t)bps * 100 >= (uint64_t)pr->target_bps * 95;
    }

    uint8_t p[24] = {0};
    p[0] = pr->id;
    p[1] = pass ? 0 : 1;
    wr32(p + 4, pr->packets);
    wr32(p + 8, pr->bytes);
    wr32(p + 12, lost);
    wr32(p + 16, corrupt);
    wr32(p + 20, bps);
    send_packet(T_PROBE_RESULT, p, sizeof(p));

    ESP_LOGI(TAG, "probe %u %s: rx=%" PRIu32 " pkts %" PRIu32 " B, lost=%" PRIu32
                  " corrupt=%" PRIu32 " busy=%" PRIu32 " -> %" PRIu32 " bps%s",
             pr->id, pass ? "pass" : "FAIL", pr->packets, pr->bytes, lost, corrupt,
             busy, bps, end ? "" : " (no PROBE_END)");

    if (pr->mode == 0) {
        s.max_bps = bps;
        if (bps == 0) {
            ESP_LOGW(TAG, "max-rate probe got no data; configuring without a rate limit");
            configure_and_start();
            return;
        }
        s.attempt = 1;
        start_probe(1, bps / 10 * 8, PROBE_STABLE_MS);
    } else if (pass) {
        s.stable_bps = pr->target_bps;
        configure_and_start();
    } else if (s.attempt < PROBE_ATTEMPTS) {
        s.attempt++;
        start_probe(1, pr->target_bps / 100 * 85, PROBE_STABLE_MS);
    } else {
        s.stable_bps = pr->target_bps / 100 * 85;
        ESP_LOGW(TAG, "no stable rate after %d attempts; assuming %" PRIu32 " bps",
                 PROBE_ATTEMPTS, s.stable_bps);
        configure_and_start();
    }
}

static uint8_t sample_bytes(uint8_t format)
{
    switch (format) {
    case 3:  return 3;
    case 4:
    case 5:  return 4;
    default: return 2;
    }
}

static uint8_t frames_for_rate(uint32_t rate, uint8_t f_max)
{
    uint32_t f = rate / PACKETS_PER_SECOND_MIN;
    if (f < 1) {
        f = 1;
    }
    return f < f_max ? f : f_max;
}

/* Spec §7: bps = fs / F * (34 + F*C*B) * 8. */
static uint64_t required_bps(uint32_t rate, uint8_t f, uint32_t frame_bytes)
{
    uint64_t packets = (rate + f - 1) / f;
    return packets * (DATA_FIXED_BYTES + (uint64_t)f * frame_bytes) * 8;
}

static void send_config(uint32_t rate)
{
    uint8_t f = frames_for_rate(rate, s.f_max);
    uint8_t p[12];

    wr32(p, rate);
    wr16(p + 4, (uint16_t)((1u << s.channels) - 1));
    p[6] = f;
    p[7] = (s.caps & CAP_CRC) ? 1 : 0;
    wr16(p + 8, 100);
    wr16(p + 10, DEFAULT_HEARTBEAT_MS);

    ESP_LOGI(TAG, "config: %" PRIu32 " Hz, %u frames/packet, %" PRIu64 " bps "
                  "(stable %" PRIu32 ", max %" PRIu32 ")",
             rate, f, required_bps(rate, f, s.frame_bytes), s.stable_bps, s.max_bps);
    send_request(T_CONFIG, p, sizeof(p), ST_WAIT_CONFIG_ACK);
}

static bool over_budget(uint32_t rate)
{
    return required_bps(rate, frames_for_rate(rate, s.f_max), s.frame_bytes) > s.budget;
}

static void configure_and_start(void)
{
    if (!(s.caps & CAP_CONFIG)) {
        /* The sensor decides its own rate and starts on its own. */
        s.last_rx_us = esp_timer_get_time();
        s.window_start_us = s.last_rx_us;
        set_state(ST_STREAMING, 0);
        return;
    }

    s.frame_bytes = (uint32_t)s.channels * sample_bytes(s.sample_format);
    uint32_t fit = s.max_packet > DATA_FIXED_BYTES
                   ? (s.max_packet - DATA_FIXED_BYTES) / s.frame_bytes : 1;
    s.f_max = fit < 1 ? 1 : fit > 255 ? 255 : fit;
    if (s.max_fpp && s.max_fpp < s.f_max) {
        s.f_max = s.max_fpp;
    }
    s.budget = s.stable_bps ? (uint64_t)s.stable_bps * 7 / 10 : UINT64_MAX;
    s.config_tries = 0;

    uint32_t lo = s.rate_min ? s.rate_min : 1;
    uint32_t hi = s.rate_max >= lo ? s.rate_max : lo;
    uint32_t rate = lo;
    bool fits = false;

    for (uint32_t r = hi; r >= lo; r--) {
        if (!over_budget(r)) {
            rate = r;
            fits = true;
            break;
        }
    }
    if (!fits) {
        ESP_LOGW(TAG, "even %" PRIu32 " Hz is over the %" PRIu64 " bps budget; using it anyway",
                 rate, s.budget);
    }
    send_config(rate);
}

/* The sensor may round the requested rate to one it supports, possibly
 * upward (spec §6 CONFIG_ACK status 1). Step down until the applied
 * rate fits the budget again. */
static void handle_config_ack(const uint8_t *p)
{
    uint32_t applied = rd32(p + 4);
    uint32_t lo = s.rate_min ? s.rate_min : 1;

    ESP_LOGI(TAG, "config ack: status %u, applied %" PRIu32 " Hz, %u frames/packet",
             p[0], applied, p[10]);

    if (over_budget(applied) && applied > lo && s.config_tries < CONFIG_STEP_DOWNS) {
        uint32_t lower = applied / 3 * 2;
        s.config_tries++;
        ESP_LOGW(TAG, "applied %" PRIu32 " Hz is over budget; asking for %" PRIu32 " Hz",
                 applied, lower < lo ? lo : lower);
        send_config(lower < lo ? lo : lower);
        return;
    }

    s.scan_rate = applied;
    s.fpp = p[10];
    s.heartbeat_ms = rd16(p + 14) ? rd16(p + 14) : DEFAULT_HEARTBEAT_MS;
    send_request(T_START, NULL, 0, ST_WAIT_START);
}

static void renegotiate(const char *why)
{
    if ((s.caps & (CAP_PROBE | CAP_CONFIG)) != (CAP_PROBE | CAP_CONFIG)) {
        return;
    }
    ESP_LOGW(TAG, "renegotiating link rate: %s", why);
    send_request(T_STOP, NULL, 0, ST_WAIT_STOP);
}

/* ----- received packets ----------------------------------------------- */

static void handle_hello(const uint8_t *p, uint16_t len)
{
    if (len < 37 || p[36] > 32 || len < 37 + p[36]) {
        send_error(ERR_BAD_LENGTH, T_HELLO, 0);
        return;
    }

    uint8_t proto_min = p[0], proto_max = p[1];
    s.sample_format = p[3];
    memcpy(s.device_id, p + 4, 8);
    s.caps = rd32(p + 16);
    s.channels = p[20];
    s.max_fpp = p[21];
    s.rate_min = rd32(p + 24);
    s.rate_max = rd32(p + 28);
    s.rate_cur = rd32(p + 32);
    memcpy(s.name, p + 37, p[36]);
    s.name[p[36]] = '\0';

    uint8_t status = HELLO_ST_OK;
    if (proto_min > FL_VERSION || proto_max < FL_VERSION) {
        status = HELLO_ST_VERSION;
    } else if (p[2] != DEVICE_CLASS_SENSOR) {
        status = HELLO_ST_CLASS;
    } else if (s.sample_format < 1 || s.sample_format > 5 ||
               s.channels < 1 || s.channels > 16) {
        status = HELLO_ST_FORMAT;
    }

    s.max_packet = link_max_packet();
    uint32_t caps_sel = s.caps & (CAP_CRC | CAP_PROBE | CAP_CONFIG | CAP_TIMESTAMP);

    uint8_t a[26];
    a[0] = status;
    a[1] = FL_VERSION;
    a[2] = GATEWAY_CLASS;
    a[3] = (s.caps & CAP_CRC) ? 1 : 0;
    memcpy(a + 4, s_gateway_id, 8);
    wr16(a + 12, GATEWAY_FW_VERSION);
    wr16(a + 14, s.max_packet);
    wr32(a + 16, caps_sel);
    wr16(a + 20, DEFAULT_HEARTBEAT_MS);
    wr32(a + 22, 0xffffffff);   /* no level D resume */
    send_packet(T_HELLO_ACK, a, sizeof(a));

    ESP_LOGI(TAG, "HELLO from \"%s\" id=%02x%02x%02x%02x%02x%02x%02x%02x model=0x%04x "
                  "fw=%u.%u caps=0x%" PRIx32 " ch=%u fmt=%u rate=%" PRIu32 " (%" PRIu32
                  "..%" PRIu32 " Hz) -> status %u",
             s.name, s.device_id[0], s.device_id[1], s.device_id[2], s.device_id[3],
             s.device_id[4], s.device_id[5], s.device_id[6], s.device_id[7],
             rd16(p + 12), p[15], p[14], s.caps, s.channels, s.sample_format,
             s.rate_cur, s.rate_min, s.rate_max, status);

    if (status != HELLO_ST_OK) {
        set_state(ST_REJECTED, REJECT_LINGER_US);
        return;
    }

    s.scan_rate = s.rate_cur;
    s.heartbeat_ms = DEFAULT_HEARTBEAT_MS;
    s.have_sample_seq = false;
    s.have_hb = false;
    if (s.caps & (CAP_PROBE | CAP_CONFIG)) {
        s.level = 'C';
        set_state(ST_WAIT_LINK_INFO, LINK_INFO_WAIT_US);
    } else {
        s.level = 'B';
        s.last_rx_us = esp_timer_get_time();
        s.window_start_us = s.last_rx_us;
        set_state(ST_STREAMING, 0);
    }
}

static void handle_link_info(const uint8_t *p, uint16_t len)
{
    if (len < 12) {
        send_error(ERR_BAD_LENGTH, T_LINK_INFO, 0);
        return;
    }
    ESP_LOGI(TAG, "sensor link: mtu=%u phy=%u/%u itvl=%.2f ms latency=%u timeout=%u ms dle=%u",
             rd16(p), p[2], p[3], rd16(p + 4) * 1.25, rd16(p + 6),
             rd16(p + 8) * 10, rd16(p + 10));
    send_link_info();
    if (s.state == ST_WAIT_LINK_INFO) {
        begin_negotiation();
    }
}

static void handle_probe_data(const uint8_t *p, uint16_t len, uint32_t total)
{
    probe_t *pr = &s.probe;

    if (s.state != ST_PROBING || len < 6 || p[0] != pr->id) {
        return;
    }
    uint32_t seq = rd32(p + 2);
    int64_t now = esp_timer_get_time();

    if (pr->packets == 0) {
        pr->t_first = now;
        pr->first_bytes = total;
    }
    pr->t_last = now;
    pr->packets++;
    pr->bytes += total;
    if (pr->have_seq && seq != pr->last_seq + 1) {
        uint32_t gap = seq - pr->last_seq - 1;
        if (gap < 0x80000000u) {
            pr->gaps += gap;
        }
    }
    pr->have_seq = true;
    pr->last_seq = seq;

    for (uint16_t k = 6; k < len; k++) {
        if (p[k] != (uint8_t)(seq + (k - 6))) {
            pr->corrupt++;
            break;
        }
    }
}

static uint16_t sample_to_code(const uint8_t *p, uint8_t format)
{
    switch (format) {
    case 1:
        return rd16(p);
    case 2:     /* i16 -> offset binary */
        return (uint16_t)((int32_t)(int16_t)rd16(p) + 32768);
    case 3: {
        uint32_t u = p[0] | p[1] << 8 | (uint32_t)p[2] << 16;
        if (u & 0x800000u) {
            u |= 0xff000000u;
        }
        return (uint16_t)(((int32_t)u >> 8) + 32768);
    }
    case 4:
        return (uint16_t)(((int32_t)rd32(p) >> 16) + 32768);
    case 5: {   /* f32 taken as volts on the collector's +-10.24 V scale */
        float v;
        memcpy(&v, p, sizeof(v));
        float code = (v + 10.24f) / 20.48f * 65536.0f;
        return code <= 0 ? 0 : code >= 65535 ? 65535 : (uint16_t)code;
    }
    default:
        return 32768;
    }
}

static void handle_data(const uint8_t *p, uint16_t len, uint16_t seq)
{
    if (len < 20) {
        send_error(ERR_BAD_LENGTH, T_DATA, seq);
        return;
    }
    uint32_t sample_seq = rd32(p);
    uint64_t ts_us = rd64(p + 4);
    uint32_t rate = rd32(p + 12);
    uint8_t count = p[16], channels = p[17], format = p[18];
    uint8_t bytes = sample_bytes(format);

    if (channels == 0 || 20 + (uint32_t)count * channels * bytes != len) {
        send_error(ERR_BAD_LENGTH, T_DATA, seq);
        return;
    }
    if (rate == 0) {
        rate = s.scan_rate ? s.scan_rate : 1;
    }

    if (s.have_sample_seq && sample_seq != s.next_sample_seq) {
        uint32_t gap = sample_seq - s.next_sample_seq;
        if (gap < 0x80000000u) {
            s_stats.lost_frames += gap;
            s.window_lost += gap;
        } else {
            ESP_LOGW(TAG, "sample_seq went back to %" PRIu32 " (sensor restart?)", sample_seq);
        }
    }
    s.have_sample_seq = true;
    s.next_sample_seq = sample_seq + count;
    s.window_rx += count;

    bool sensor_time = (s.caps & CAP_TIMESTAMP) && ts_us != 0;
    int64_t now_us = esp_timer_get_time();
    const uint8_t *sample = p + 20;

    for (uint8_t i = 0; i < count; i++) {
        Ads8688StreamFrame f;
        memset(&f, 0, sizeof(f));
        f.magic = ADS8688_STREAM_MAGIC;
        f.version = ADS8688_STREAM_VERSION;
        f.headerBytes = offsetof(Ads8688StreamFrame, samples);
        f.sequence = sample_seq + i;
        f.timestampUs = sensor_time
                        ? ts_us + (uint64_t)i * 1000000 / rate
                        : (uint64_t)(now_us - (int64_t)(count - 1 - i) * 1000000 / rate);
        f.scanRateHz = rate;
        f.channelCount = ADS8688_STREAM_CHANNELS;
        f.sampleFormat = ADS8688_STREAM_SAMPLE_U16;
        for (uint8_t ch = 0; ch < ADS8688_STREAM_CHANNELS; ch++) {
            /* Channels the sensor does not have read as 0 V. */
            f.samples[ch] = ch < channels ? sample_to_code(sample + ch * bytes, format) : 32768;
        }
        f.crc32 = Ads8688Stream_crc32(&f, offsetof(Ads8688StreamFrame, crc32));
        sample += channels * bytes;

        s_stats.frames++;
        if (s_on_frame) {
            s_on_frame(&f);
        }
    }
}

static void handle_heartbeat(const uint8_t *p, uint16_t len)
{
    if (len < 13) {
        send_error(ERR_BAD_LENGTH, T_HEARTBEAT, 0);
        return;
    }
    uint16_t used = rd16(p + 4);
    uint32_t dropped = rd32(p + 8);

    if (s.have_hb) {
        /* Loss is counted from sample_seq gaps only: a sensor that drops
         * frames still advances sample_seq past them, so adding this
         * counter as well would count every lost frame twice. */
        if (dropped > s.last_dropped) {
            ESP_LOGW(TAG, "sensor dropped %" PRIu32 " frames (total %" PRIu32 ")",
                     dropped - s.last_dropped, dropped);
        }
        s.queue_rise = used > s.last_queue_used ? s.queue_rise + 1 : 0;
    }
    s.have_hb = true;
    s.last_dropped = dropped;
    s.last_queue_used = used;

    ESP_LOGD(TAG, "heartbeat: up=%" PRIu32 " ms queue=%u/%u dropped=%" PRIu32 " batt=%u",
             rd32(p), used, rd16(p + 6), dropped, p[12]);

    if (s.state == ST_STREAMING && s.queue_rise >= QUEUE_RISE_LIMIT) {
        s.queue_rise = 0;
        renegotiate("sensor TX queue kept growing");
    }
}

static void handle_packet(uint8_t type, uint8_t flags, uint16_t seq,
                          const uint8_t *p, uint16_t len, uint32_t total)
{
    s.last_rx_us = esp_timer_get_time();

    /* Spec §4: everything but DATA / PROBE_DATA must carry a CRC. Without
     * one, a false sync inside sample data could pass as a command. */
    if (!(flags & FL_F_CRC) && type != T_DATA && type != T_PROBE_DATA) {
        ESP_LOGW(TAG, "dropping control packet 0x%02x without CRC", type);
        return;
    }

    switch (type) {
    case T_HELLO:
        handle_hello(p, len);
        break;
    case T_LINK_INFO:
        handle_link_info(p, len);
        break;
    case T_PROBE_DATA:
        handle_probe_data(p, len, total);
        break;
    case T_PROBE_END:
        if (s.state == ST_PROBING && len >= 20 && p[0] == s.probe.id) {
            finish_probe(p);
        }
        break;
    case T_CONFIG_ACK:
        if (s.state == ST_WAIT_CONFIG_ACK && len >= 16) {
            handle_config_ack(p);
        }
        break;
    case T_RESULT:
        if (len < 4) {
            break;
        }
        if (s.state == ST_WAIT_START && p[0] == T_START) {
            if (p[1] != 0) {
                link_disconnect("sensor refused START");
                break;
            }
            ESP_LOGI(TAG, "streaming from \"%s\"", s.name);
            s.window_start_us = esp_timer_get_time();
            s.window_rx = s.window_lost = 0;
            set_state(ST_STREAMING, 0);
        } else if (s.state == ST_WAIT_STOP && p[0] == T_STOP) {
            begin_negotiation();
        }
        break;
    case T_DATA:
        handle_data(p, len, seq);
        break;
    case T_HEARTBEAT:
        handle_heartbeat(p, len);
        break;
    case T_ERROR:
        ESP_LOGW(TAG, "sensor ERROR code=%u for type 0x%02x seq=%u",
                 len >= 1 ? p[0] : 0, len >= 2 ? p[1] : 0, len >= 4 ? rd16(p + 2) : 0);
        break;
    default:
        send_error(ERR_UNSUPPORTED, type, seq);
        break;
    }
}

static void handle_raw_frame(const Ads8688StreamFrame *frame)
{
    if (s.level != 'A') {
        s.level = 'A';
        set_state(ST_STREAMING_A, 0);
        ESP_LOGI(TAG, "level A sensor: raw ADS8 frames");
    }
    s.last_rx_us = esp_timer_get_time();
    s_stats.frames++;
    if (s_on_frame) {
        s_on_frame(frame);
    }
}

/* ----- byte stream parser --------------------------------------------- */

static void parse(void)
{
    size_t pos = 0;

    while (s_len - pos >= 2) {
        const uint8_t *p = &s_buf[pos];
        size_t avail = s_len - pos;

        if (p[0] == 'F' && p[1] == 'L') {
            if (avail < FL_HDR) {
                break;
            }
            uint16_t len = rd16(p + 8);
            /* Undefined flag bits and the reserved byte must be zero; a
             * level A stream only ever carries CRC-protected FL packets,
             * so "FL" inside its sample data cannot pass as a packet. */
            if (p[2] != FL_VERSION || (p[4] & 0xf8) || p[5] != 0 ||
                len > FL_MAX_PAYLOAD ||
                (s.level == 'A' && !(p[4] & FL_F_CRC))) {
                pos++;
                s_stats.skipped_bytes++;
                continue;
            }
            uint32_t total = FL_HDR + len + ((p[4] & FL_F_CRC) ? FL_CRC : 0);
            if (avail < total) {
                break;
            }
            if ((p[4] & FL_F_CRC) &&
                rd32(p + FL_HDR + len) != Ads8688Stream_crc32(p, FL_HDR + len)) {
                pos++;
                s_stats.crc_failures++;
                s_stats.skipped_bytes++;
                continue;
            }
            handle_packet(p[3], p[4], rd16(p + 6), p + FL_HDR, len, total);
            pos += total;
            continue;
        }

        if (p[0] == 'A' && p[1] == 'D') {
            if (avail < sizeof(Ads8688StreamFrame)) {
                break;
            }
            Ads8688StreamFrame frame;
            memcpy(&frame, p, sizeof(frame));
            if (Ads8688Stream_isValid(&frame)) {
                handle_raw_frame(&frame);
                pos += sizeof(frame);
                continue;
            }
            s_stats.crc_failures++;
        }

        pos++;
        s_stats.skipped_bytes++;
    }

    /* A full buffer that still holds no complete packet means a bogus
     * length field: drop a byte so the parser cannot stall. */
    if (pos == 0 && s_len == sizeof(s_buf)) {
        pos = 1;
        s_stats.skipped_bytes++;
    }
    memmove(s_buf, &s_buf[pos], s_len - pos);
    s_len -= pos;
}

/* ----- session timers -------------------------------------------------- */

static void tick(int64_t now)
{
    bool expired = s.deadline && now >= s.deadline;

    switch (s.state) {
    case ST_WAIT_HELLO:
        if (expired) {
            link_disconnect("no HELLO within 5 s");
        }
        break;
    case ST_REJECTED:
        if (expired) {
            link_disconnect("HELLO rejected");
        }
        break;
    case ST_WAIT_LINK_INFO:
        if (expired) {
            send_link_info();
            begin_negotiation();
        }
        break;
    case ST_PROBING:
        if (expired) {
            finish_probe(NULL);
        }
        break;
    case ST_WAIT_CONFIG_ACK:
    case ST_WAIT_START:
    case ST_WAIT_STOP:
        if (!expired) {
            break;
        }
        if (s.retries < REQUEST_RETRIES) {
            s.retries++;
            ESP_LOGW(TAG, "no reply to 0x%02x, retry %u", s.pend_type, s.retries);
            send_packet(s.pend_type, s.pend_payload, s.pend_len);
            s.deadline = now + REQUEST_TIMEOUT_US;
        } else {
            link_disconnect("no reply after retries");
        }
        break;
    case ST_STREAMING:
        if (now - s.last_rx_us > 3LL * s.heartbeat_ms * 1000) {
            link_disconnect("stream stalled");
            break;
        }
        if (now - s.window_start_us >= LOSS_WINDOW_US) {
            uint32_t total = s.window_rx + s.window_lost;
            bool lossy = total > 0 && (uint64_t)s.window_lost * 100 > total;
            if (s.window_lost) {
                ESP_LOGW(TAG, "lost %" PRIu32 " of %" PRIu32 " frames in the last 10 s",
                         s.window_lost, total);
            }
            s.window_start_us = now;
            s.window_rx = s.window_lost = 0;
            if (lossy) {
                renegotiate("frame loss above 1%");
            }
        }
        break;
    case ST_CLOSING:
        if (expired) {
            set_state(ST_IDLE, 0);
        }
        break;
    default:
        break;
    }
}

static void session_reset(void)
{
    memset(&s, 0, sizeof(s));
    s.state = ST_IDLE;
    s.level = '-';
    s_len = 0;
    xStreamBufferReset(s_rx);
}

static void handle_ble_event(const ble_uart_evt_t *e)
{
    switch (e->id) {
    case BLE_UART_EVT_CONNECTED:
        session_reset();
        s.have_peer = true;
        s.peer.type = e->connected.peer.type;
        for (int i = 0; i < 6; i++) {
            s.peer.val[i] = e->connected.peer.bytes[5 - i];
        }
        set_state(ST_WAIT_HELLO, HELLO_TIMEOUT_US);
        break;
    case BLE_UART_EVT_DISCONNECTED:
        if (s.state != ST_IDLE) {
            ESP_LOGI(TAG, "sensor \"%s\" gone (%s)", s.name, k_state_names[s.state]);
        }
        session_reset();
        break;
    default:
        break;
    }
}

static void link_task(void *arg)
{
    uint8_t chunk[512];

    for (;;) {
        ble_uart_evt_t evt;
        while (xQueueReceive(s_evt_q, &evt, 0) == pdTRUE) {
            handle_ble_event(&evt);
        }

        size_t n = xStreamBufferReceive(s_rx, chunk, sizeof(chunk), pdMS_TO_TICKS(POLL_MS));
        while (n > 0) {
            size_t room = sizeof(s_buf) - s_len;
            size_t take = n < room ? n : room;
            memcpy(&s_buf[s_len], chunk, take);
            s_len += take;
            memmove(chunk, chunk + take, n - take);
            n -= take;
            parse();
        }

        tick(esp_timer_get_time());
    }
}

/* ----- public API ----------------------------------------------------- */

esp_err_t fl_link_start(fl_link_frame_cb_t on_frame, const uint8_t gateway_id[8])
{
    s_on_frame = on_frame;
    memcpy(s_gateway_id, gateway_id, sizeof(s_gateway_id));

    s_rx = xStreamBufferCreate(RX_STREAM_SIZE, 1);
    s_evt_q = xQueueCreate(EVT_QUEUE_LEN, sizeof(ble_uart_evt_t));
    ESP_RETURN_ON_FALSE(s_rx && s_evt_q, ESP_ERR_NO_MEM, TAG, "buffers");
    session_reset();

    ESP_RETURN_ON_FALSE(xTaskCreate(link_task, "fl_link", 6144, NULL, 6, NULL) == pdPASS,
                        ESP_ERR_NO_MEM, TAG, "task");
    return ESP_OK;
}

void fl_link_feed(const uint8_t *data, size_t len)
{
#if CONFIG_FIELDLINK_DUMP_BLE_RX
    static int64_t s_last_us;
    int64_t now_us = esp_timer_get_time();
    ESP_LOGI("ble_rx", "ble rx %u B  gap=%" PRId64 " ms", (unsigned)len,
             s_last_us ? (now_us - s_last_us) / 1000 : 0);
    ESP_LOG_BUFFER_HEXDUMP("ble_rx", data, len, ESP_LOG_INFO);
    s_last_us = now_us;
#endif

    s_stats.rx_bytes += len;
    if (s_rx == NULL) {
        return;
    }
    size_t sent = xStreamBufferSend(s_rx, data, len, 0);
    if (sent < len) {
        s_stats.rx_overflow += len - sent;
    }
}

void fl_link_on_ble_event(const ble_uart_evt_t *evt)
{
    if (s_evt_q && (evt->id == BLE_UART_EVT_CONNECTED ||
                    evt->id == BLE_UART_EVT_DISCONNECTED)) {
        xQueueSend(s_evt_q, evt, 0);
    }
}

void fl_link_get_stats(fl_link_stats_t *out)
{
    *out = s_stats;
}

void fl_link_get_session(fl_link_session_t *out)
{
    /* Best-effort snapshot from another task; fields may be mid-update. */
    out->state = k_state_names[s.state];
    out->level = s.level;
    memcpy(out->name, s.name, sizeof(out->name));
    out->name[sizeof(out->name) - 1] = '\0';
    memcpy(out->device_id, s.device_id, sizeof(out->device_id));
    out->channels = s.channels;
    out->sample_format = s.sample_format;
    out->max_bps = s.max_bps;
    out->stable_bps = s.stable_bps;
    out->scan_rate_hz = s.scan_rate;
    out->frames_per_packet = s.fpp;
}
