#include <string.h>

#include "archive.h"

#define MID_SCALE_CODE 32768

/* Everything a rebuilt frame needs besides the protocol constants. */
typedef struct __attribute__((packed)) {
    uint64_t unix_ns;
    uint64_t timestamp_us;
    uint32_t sequence;
    uint32_t scan_rate_hz;
    uint16_t samples[];
} record_t;

static uint8_t *s_buf;
static size_t s_record_bytes;
static unsigned s_channels;
static uint32_t s_capacity;
static uint32_t s_count;
static uint32_t s_head;      /* slot of the oldest record */
static uint64_t s_earliest;  /* record id in slot s_head */

size_t archive_record_bytes(unsigned channels)
{
    return sizeof(record_t) + channels * sizeof(uint16_t);
}

void archive_init(void *buf, size_t bytes, unsigned channels)
{
    s_channels = channels > ADS8688_STREAM_CHANNELS ? ADS8688_STREAM_CHANNELS : channels;
    s_record_bytes = archive_record_bytes(s_channels);
    s_buf = buf;
    s_capacity = buf ? (uint32_t)(bytes / s_record_bytes) : 0;
    s_count = 0;
    s_head = 0;
    s_earliest = 0;
}

static record_t *slot(uint32_t index)
{
    return (record_t *)(s_buf + (size_t)index * s_record_bytes);
}

void archive_append(uint64_t record_id, uint64_t unix_ns, const Ads8688StreamFrame *frame)
{
    if (s_capacity == 0) {
        return;
    }
    if (s_count > 0 && record_id != s_earliest + s_count) {
        s_count = 0;  /* ids must stay consecutive for index lookup */
    }
    if (s_count == 0) {
        s_head = 0;
        s_earliest = record_id;
    }

    record_t *r;
    if (s_count < s_capacity) {
        r = slot((s_head + s_count) % s_capacity);
        s_count++;
    } else {
        r = slot(s_head);  /* overwrite the oldest */
        s_head = (s_head + 1) % s_capacity;
        s_earliest++;
    }
    r->unix_ns = unix_ns;
    r->timestamp_us = frame->timestampUs;
    r->sequence = frame->sequence;
    r->scan_rate_hz = frame->scanRateHz;
    memcpy(r->samples, frame->samples, s_channels * sizeof(uint16_t));
}

void archive_get_info(archive_info_t *out)
{
    out->enabled = s_capacity > 0;
    out->count = s_count;
    out->capacity = s_capacity;
    out->record_bytes = s_record_bytes;
    out->earliest = s_earliest;
    out->latest = s_count ? s_earliest + s_count - 1 : 0;
}

bool archive_read(uint64_t record_id, uint64_t *unix_ns, Ads8688StreamFrame *frame)
{
    if (s_count == 0 || record_id < s_earliest || record_id - s_earliest >= s_count) {
        return false;
    }
    const record_t *r = slot((uint32_t)((s_head + (record_id - s_earliest)) % s_capacity));

    memset(frame, 0, sizeof(*frame));
    frame->magic = ADS8688_STREAM_MAGIC;
    frame->version = ADS8688_STREAM_VERSION;
    frame->headerBytes = offsetof(Ads8688StreamFrame, samples);
    frame->sequence = r->sequence;
    frame->timestampUs = r->timestamp_us;
    frame->scanRateHz = r->scan_rate_hz;
    frame->channelCount = ADS8688_STREAM_CHANNELS;
    frame->sampleFormat = ADS8688_STREAM_SAMPLE_U16;
    for (unsigned ch = 0; ch < ADS8688_STREAM_CHANNELS; ch++) {
        frame->samples[ch] = ch < s_channels ? r->samples[ch] : MID_SCALE_CODE;
    }
    frame->crc32 = Ads8688Stream_crc32(frame, offsetof(Ads8688StreamFrame, crc32));
    *unix_ns = r->unix_ns;
    return true;
}
