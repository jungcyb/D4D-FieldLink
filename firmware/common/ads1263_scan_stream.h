#ifndef ADS1263_SCAN_STREAM_H_
#define ADS1263_SCAN_STREAM_H_

/* R5FSS1-0 ADS1263 4-channel differential scan <-> Linux (rpmsg_chrdev).
 *
 * One frame per completed scan of AIN0-AIN1, AIN2-AIN3, AIN4-AIN5, AIN6-AIN7.
 * 48 bytes, the same size as Ads8688StreamFrame, so ads8688d stores both in
 * the same 64-byte segment record layout. Little-endian, CRC32 (IEEE) over
 * every byte before crc32. Control packets reuse Ads1263Control ("CTL6"). */

#include <stddef.h>
#include <stdint.h>

#include "ads1263_stream.h"

#define ADS1263_SCAN_MAGIC            (0x53363241U) /* "A26S" */
#define ADS1263_SCAN_VERSION          (1U)
#define ADS1263_SCAN_CHANNELS         (4U)

/* timeoutMask bit n: channel n saw no DRDY within the per-channel timeout;
 * its code is 0 and its status byte is 0. */
#define ADS1263_SCAN_RATE_DEFAULT_HZ  (100U)
#define ADS1263_SCAN_RATE_MIN_HZ      (1U)
#define ADS1263_SCAN_RATE_MAX_HZ      (300U)

/* Control commands added for the scan firmware (CTL6, value = scan rate Hz).
 * GET_STATUS ACK value: bit31 online, bit30 acquiring, bits16-29 configuration
 * recoveries (saturating), bits0-15 scan rate Hz. */
#define ADS1263_CONTROL_SET_RATE      (6U)

/* Reply to any non-control message from Linux (the subscription write). */
#define ADS1263_SCAN_HELLO_REPLY      "A26OK"

typedef struct __attribute__((packed))
{
    uint32_t magic;
    uint16_t version;
    uint8_t channelCount;
    uint8_t timeoutMask;
    uint32_t sequence;
    uint64_t timestampUs;   /* R5 time at scan start */
    uint32_t scanRateHz;    /* configured scans per second */
    uint8_t status[ADS1263_SCAN_CHANNELS]; /* ADS1263 status byte per channel */
    int32_t codes[ADS1263_SCAN_CHANNELS];  /* ADC1 signed 32-bit, Vref = 2.5 V */
    uint32_t crc32;
} Ads1263ScanFrame;

_Static_assert(sizeof(Ads1263ScanFrame) == 48U, "scan frame wire size");

static inline int32_t Ads1263Scan_isValid(const Ads1263ScanFrame *frame)
{
    return (frame->magic == ADS1263_SCAN_MAGIC) &&
           (frame->version == ADS1263_SCAN_VERSION) &&
           (frame->channelCount == ADS1263_SCAN_CHANNELS) &&
           (frame->crc32 == Ads1263_crc32(frame, offsetof(Ads1263ScanFrame, crc32)));
}

#endif
