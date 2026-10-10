#ifndef ADS1263_STREAM_H_
#define ADS1263_STREAM_H_

#include <stddef.h>
#include <stdint.h>

#define ADS1263_STREAM_MAGIC          (0x36323141U) /* "A126" */
#define ADS1263_STREAM_VERSION        (2U) /* Both codes are ADC1 signed 32-bit */
#define ADS1263_FRAME_SAMPLE          (1U)
#define ADS1263_FRAME_STATUS          (2U)

#define ADS1263_FLAG_DEVICE_ONLINE    (1U << 0)
#define ADS1263_FLAG_ACQUIRING        (1U << 1)
#define ADS1263_FLAG_PRESSURE_NEW     (1U << 2)
#define ADS1263_FLAG_THERMOCOUPLE_NEW (1U << 3)

#define ADS1263_CONTROL_MAGIC         (0x364C5443U) /* "CTL6" */
#define ADS1263_CONTROL_VERSION       (1U)
#define ADS1263_CONTROL_ACK           (0x8000U)
#define ADS1263_CONTROL_GET_STATUS    (1U)
#define ADS1263_CONTROL_START         (2U)
#define ADS1263_CONTROL_STOP          (3U)
#define ADS1263_CONTROL_RESET         (4U)
#define ADS1263_CONTROL_DIAGNOSTIC    (5U) /* value: 0 stop, 1 start, 2 heartbeat */
#define ADS1263_DIAGNOSTIC_MAGIC      (0x36323144U) /* "D126", never normal samples */
#define ADS1263_DIAGNOSTIC_VERSION    (3U) /* STM direct read, five bytes */
#define ADS1263_DIAG_CONFIG_OK        (1U << 0)
#define ADS1263_DIAG_MUX_WRITTEN      (1U << 1) /* SPI completed, NOT ADC readback */
#define ADS1263_DIAG_DRDY_LOW         (1U << 2)

#define ADS1263_LINUX_ENDPOINT        (14U)
#define ADS1263_LINUX_SERVICE         "rpmsg_chrdev"

/* Zero = unmeasured DRDY-driven scan rate. ADC setting is 4800 SPS, shared by
 * both sequential inputs; report actual readout rates from timestamps. */
#define ADS1263_PRESSURE_SPS          (0U)
#define ADS1263_THERMOCOUPLE_SPS      (0U)

typedef struct __attribute__((packed))
{
    uint32_t magic;
    uint16_t version;
    uint8_t frameType;
    uint8_t adcStatus;
    uint32_t sequence;
    uint64_t timestampUs;
    int32_t pressureCode;
    int32_t thermocoupleCode;
    uint32_t flags;
    uint16_t pressureSps;
    uint16_t thermocoupleSps;
    uint32_t crcErrors;
    uint32_t ioErrors;
    uint32_t crc32;
} Ads1263StreamFrame;

/* Raw SPI readouts, checksum not clocked (STM behavior). Separate wire format. */
typedef struct __attribute__((packed))
{
    uint32_t magic;
    uint16_t version;
    uint8_t channel; /* 1: AIN0-AIN1, 2: AIN6-AIN7; BOTH use ADC1 */
    uint8_t length; /* 5 = direct read attempted; 0 = waiting / MUX transfer error */
    uint32_t sequence;
    uint64_t timestampUs;
    int32_t spiStatus;
    uint8_t rx[7];
    uint8_t flags; /* startup config, MUX write completion, DRDY; not validity proof */
    uint32_t crc32;
} Ads1263DiagnosticFrame;

_Static_assert(sizeof(Ads1263DiagnosticFrame) == 36U, "diagnostic wire size");

typedef struct __attribute__((packed))
{
    uint32_t magic;
    uint16_t version;
    uint16_t command;
    uint32_t requestId;
    uint32_t value;
    int32_t status;
    uint32_t crc32;
} Ads1263Control;

static inline uint32_t Ads1263_crc32(const void *data, size_t length)
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

static inline int32_t Ads1263Control_isValid(const Ads1263Control *control)
{
    return (control->magic == ADS1263_CONTROL_MAGIC) &&
           (control->version == ADS1263_CONTROL_VERSION) &&
           (control->crc32 == Ads1263_crc32(control,
                               offsetof(Ads1263Control, crc32)));
}

#endif
