#ifndef ADS8688_STREAM_H_
#define ADS8688_STREAM_H_

#include <stddef.h>
#include <stdint.h>

#define ADS8688_STREAM_MAGIC          (0x38534441U) /* "ADS8" */
#define ADS8688_STREAM_VERSION        (1U)
#define ADS8688_STREAM_CHANNELS       (8U)
#define ADS8688_STREAM_SAMPLE_U16     (1U)
#define ADS8688_STREAM_SCAN_RATE_HZ   (1000U)
#define ADS8688_SCAN_RATE_MIN_HZ      (10U)
#define ADS8688_SCAN_RATE_MAX_HZ      (2000U)
#define ADS8688_STREAM_BATCH_MAX      (2U) /* 2 * 48 B fits the 112 B RPMsg payload. */

#define ADS8688_CONTROL_MAGIC         (0x384C5443U) /* "CTL8" */
#define ADS8688_CONTROL_VERSION       (1U)
#define ADS8688_CONTROL_ACK           (0x8000U)
#define ADS8688_CONTROL_START         (1U)
#define ADS8688_CONTROL_STOP          (2U)
#define ADS8688_CONTROL_SET_RATE      (3U)
#define ADS8688_CONTROL_GET_STATUS    (4U)

#define ADS8688_M4_R5_ENDPOINT        (40U)
#define ADS8688_LINUX_ENDPOINT        (14U)
#define ADS8688_LINUX_SERVICE         "rpmsg_chrdev"

typedef struct __attribute__((packed))
{
    uint32_t magic;
    uint16_t version;
    uint16_t headerBytes;
    uint32_t sequence;
    uint64_t timestampUs;
    uint32_t scanRateHz;
    uint16_t channelCount;
    uint16_t sampleFormat;
    uint16_t samples[ADS8688_STREAM_CHANNELS];
    uint32_t crc32;
} Ads8688StreamFrame;

typedef struct __attribute__((packed))
{
    uint32_t magic;
    uint16_t version;
    uint16_t command;
    uint32_t requestId;
    uint32_t value;
    int32_t status;
    uint32_t crc32;
} Ads8688Control;

static inline uint32_t Ads8688Stream_crc32(const void *data, size_t length)
{
    const uint8_t *bytes = (const uint8_t *)data;
    uint32_t crc = 0xFFFFFFFFU;
    size_t i;
    uint32_t bit;

    for (i = 0U; i < length; i++)
    {
        crc ^= bytes[i];
        for (bit = 0U; bit < 8U; bit++)
        {
            crc = (crc >> 1U) ^ (0xEDB88320U &
                  (uint32_t)(-(int32_t)(crc & 1U)));
        }
    }
    return ~crc;
}

static inline int32_t Ads8688Stream_isValid(const Ads8688StreamFrame *frame)
{
    uint32_t crc = Ads8688Stream_crc32(frame,
        offsetof(Ads8688StreamFrame, crc32));

    return (frame->magic == ADS8688_STREAM_MAGIC) &&
           (frame->version == ADS8688_STREAM_VERSION) &&
           (frame->headerBytes == offsetof(Ads8688StreamFrame, samples)) &&
           (frame->channelCount == ADS8688_STREAM_CHANNELS) &&
           (frame->sampleFormat == ADS8688_STREAM_SAMPLE_U16) &&
           (frame->crc32 == crc);
}

static inline int32_t Ads8688Control_isValid(const Ads8688Control *control)
{
    uint32_t crc = Ads8688Stream_crc32(control,
        offsetof(Ads8688Control, crc32));

    return (control->magic == ADS8688_CONTROL_MAGIC) &&
           (control->version == ADS8688_CONTROL_VERSION) &&
           (control->crc32 == crc);
}

#endif
