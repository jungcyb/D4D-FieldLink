/*
 * Rate converter from the sensor's real sample clock to an exact grid at
 * the advertised (integer) scan rate.
 *
 * BLE sensors declare a nominal rate (e.g. 104 Hz) while their sampling
 * clock runs a few percent off (the NU40's accelerometer runs ~107 Hz),
 * and frames arrive in bursts of one BLE packet. The collector and the
 * dashboard place samples at `timestamp + n / scanRateHz` and only join
 * batches whose ends meet within ~2 ms, so the stream must be uniform at
 * exactly scanRateHz. This module:
 *
 *  1. estimates the real input rate from sequence numbers and the
 *     sensor's timestamps (long baseline, so packet-internal timestamp
 *     error and BLE jitter average out);
 *  2. maps sensor time to the gateway's wall clock through the lower
 *     envelope of (arrival - sensor time), i.e. the least-delayed
 *     packets, rising slowly so clock drift is followed;
 *  3. emits frames on an exact grid of 1/scanRateHz in wall-clock time,
 *     interpolating each channel with an 8-point Lagrange polynomial
 *     (four input samples of delay; ~0.2 % amplitude error at 20 Hz for
 *     ~107 Hz input, degrading toward Nyquist).
 *
 * A sequence gap restarts the grid (the gap stays visible downstream);
 * a sequence restart or rate change should be followed by
 * resample_reset(). Not thread-safe: the DAQ server task is the only
 * user.
 */

#pragma once

#include <stdint.h>

#include "ads8688_stream.h"

typedef struct {
    Ads8688StreamFrame frame;  /* CRC not filled in */
    uint64_t unix_ns;
} resample_out_t;

/* Forget everything, including the rate estimate. */
void resample_reset(void);

/* Feed one input frame received at `arrival_unix_ns`; writes up to `max`
 * output frames and returns how many. */
unsigned resample_push(const Ads8688StreamFrame *in, uint64_t arrival_unix_ns,
                       resample_out_t *out, unsigned max);

/* Current input-rate estimate in Hz (the declared rate until measured). */
double resample_input_rate(void);
