/*
 * Short/long-term RMS anomaly detector (STA/LTA style) per advertised
 * channel. Two first-order IIR low-pass filters with different time
 * constants track the signal power after DC removal:
 *
 *   mean   += a_long  * (x - mean)        DC (gravity, offset) removal
 *   p_short += a_short * ((x-mean)^2 - p_short)
 *   p_long  += a_long  * ((x-mean)^2 - p_long)
 *   ratio   = sqrt(p_short / max(p_long, floor^2))
 *
 * with a = 1 - exp(-1 / (fs * tau)). A channel enters warning/alarm
 * when the ratio reaches the threshold and leaves once it drops below
 * HYSTERESIS times the threshold. Until one long time constant has
 * passed the state is "warmup".
 *
 * Not thread-safe: the DAQ server task is the only user.
 */

#pragma once

#include <stdint.h>

#include "ads8688_stream.h"

typedef enum {
    ANOMALY_WARMUP,
    ANOMALY_NORMAL,
    ANOMALY_WARNING,
    ANOMALY_ALARM,
} anomaly_state_t;

typedef struct {
    float short_tau_s;
    float long_tau_s;
    float warn_ratio;
    float alarm_ratio;
    float rms_floor_v;   /* long-term RMS never counts as below this */
} anomaly_config_t;

typedef struct {
    anomaly_state_t state;
    float rms_short_v;
    float rms_long_v;
    float ratio;
    uint64_t changed_unix_ms;  /* last state change, 0 = never */
    uint32_t events;           /* entries into warning or alarm */
} anomaly_channel_t;

void anomaly_init(const anomaly_config_t *cfg, unsigned channels);

/* Forget all history (new sensor session or scan-rate change). */
void anomaly_reset(void);

/* Feed one frame of raw (unfiltered) samples. */
void anomaly_update(const Ads8688StreamFrame *frame, uint64_t unix_ms);

void anomaly_get_config(anomaly_config_t *out);
unsigned anomaly_channels(void);
void anomaly_get_channel(unsigned ch, anomaly_channel_t *out);

/* Worst state over all channels. */
anomaly_state_t anomaly_overall(void);

const char *anomaly_state_name(anomaly_state_t state);
