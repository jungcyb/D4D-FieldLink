#include <math.h>
#include <stdbool.h>
#include <string.h>

#include "resample.h"

#define RATE_BASELINE_US  500000    /* first rate measurement after 0.5 s */
#define OFFSET_BLOCKS     5         /* lower envelope = min over this many ~1 s blocks */
#define OFFSET_TAU_S      10        /* the envelope is followed through this IIR */
#define TAPS              8         /* Lagrange points: 0.2 % error at 20 Hz / 107 Hz */
#define HISTORY           TAPS
#define LEFT              (TAPS / 2 - 1)  /* interpolate between s_hist[LEFT] and [LEFT + 1] */

typedef struct {
    double t_ns;  /* estimated sample time, wall clock */
    uint16_t samples[ADS8688_STREAM_CHANNELS];
} input_t;

static bool s_have_anchor;
static uint32_t s_seq0;
static uint64_t s_ts0_us;
static double s_rate;        /* input rate estimate, Hz */
static double s_sensor_ns;   /* sensor time of the latest input, uniform at s_rate */
static uint32_t s_out_rate;  /* declared rate = output grid rate */
static uint64_t s_last_ts_us;
static bool s_irregular;     /* seen a packet start (spacing != nominal) */
static bool s_rate_measured;

/* wall clock - sensor time: per-block minima (least-delayed packets),
 * followed by a slow IIR so timing jitter stays far below a sample. */
static double s_block_min[OFFSET_BLOCKS];
static unsigned s_block;
static uint32_t s_block_fill;
static double s_offset_ns;
static uint32_t s_offset_n;

static input_t s_hist[HISTORY];
static unsigned s_hist_len;
static bool s_have_last;
static uint32_t s_last_seq;

static bool s_have_grid;
static double s_grid0_ns;
static uint64_t s_grid_k;
static uint32_t s_out_seq;

void resample_reset(void)
{
    s_have_anchor = false;
    s_irregular = false;
    s_rate_measured = false;
    for (unsigned i = 0; i < OFFSET_BLOCKS; i++) {
        s_block_min[i] = INFINITY;
    }
    s_block = 0;
    s_block_fill = 0;
    s_offset_n = 0;
    s_hist_len = 0;
    s_have_last = false;
    s_have_grid = false;
    s_rate = 0;
    s_out_rate = 0;
}

double resample_input_rate(void)
{
    return s_rate;
}

static void restart_grid(void)
{
    s_hist_len = 0;
    s_have_grid = false;
}

static double grid_time(uint64_t k)
{
    return s_grid0_ns + (double)k * 1e9 / s_out_rate;
}

/* Lagrange weights for nodes at -LEFT..TAPS-1-LEFT (unit spacing),
 * evaluated at u in [0, 1]. */
static void lagrange_weights(double u, double w[TAPS])
{
    for (int j = 0; j < TAPS; j++) {
        double num = 1, den = 1;
        for (int m = 0; m < TAPS; m++) {
            if (m != j) {
                num *= u - (m - LEFT);
                den *= j - m;
            }
        }
        w[j] = num / den;
    }
}

unsigned resample_push(const Ads8688StreamFrame *in, uint64_t arrival_unix_ns,
                       resample_out_t *out, unsigned max)
{
    if (in->scanRateHz == 0) {
        return 0;
    }
    if (!s_have_anchor || in->scanRateHz != s_out_rate) {
        resample_reset();
        s_have_anchor = true;
        s_seq0 = in->sequence;
        s_ts0_us = in->timestampUs;
        s_out_rate = in->scanRateHz;
        s_rate = in->scanRateHz;
    }
    bool contiguous = s_have_last && in->sequence == s_last_seq + 1;

    /* 1. Input rate over the whole session baseline (sequence numbers and
     * sensor time both keep counting across lost frames). Sensors that
     * timestamp a packet and space its frames at the nominal rate only
     * have a true time on the packet's first frame, so measure there. */
    bool packet_start = !contiguous ||
                        fabs((double)(in->timestampUs - s_last_ts_us) - 1e6 / s_out_rate) > 2.0;
    s_irregular |= contiguous && packet_start;
    s_last_ts_us = in->timestampUs;
    uint32_t dseq = in->sequence - s_seq0;
    uint64_t dts = in->timestampUs - s_ts0_us;
    if ((packet_start || !s_irregular) && dts >= RATE_BASELINE_US && dseq > 0) {
        s_rate = dseq * 1e6 / (double)dts;
        if (!s_rate_measured) {
            /* Nothing has been emitted yet: start the delay estimate and
             * the grid over now that times are mapped at the real rate. */
            s_rate_measured = true;
            restart_grid();
            for (unsigned i = 0; i < OFFSET_BLOCKS; i++) {
                s_block_min[i] = INFINITY;
            }
            s_block_fill = 0;
            s_offset_n = 0;
        }
    }

    /* Sample times advance by 1/rate: a rate update changes the spacing
     * from here on and never moves past samples. */
    if (contiguous) {
        s_sensor_ns += 1e9 / s_rate;
    } else {
        s_sensor_ns = (double)in->timestampUs * 1000.0;
        restart_grid();
    }
    s_have_last = true;
    s_last_seq = in->sequence;

    /* 2. Wall clock = sensor time + least observed delay. */
    double offset = (double)arrival_unix_ns - s_sensor_ns;
    s_block_min[s_block] = fmin(s_block_min[s_block], offset);
    double envelope = INFINITY;
    for (unsigned i = 0; i < OFFSET_BLOCKS; i++) {
        envelope = fmin(envelope, s_block_min[i]);
    }
    if (++s_block_fill >= s_out_rate) {
        s_block = (s_block + 1) % OFFSET_BLOCKS;
        s_block_min[s_block] = INFINITY;
        s_block_fill = 0;
    }
    /* Running mean at first, then an IIR of OFFSET_TAU_S. */
    if (s_offset_n < OFFSET_TAU_S * s_out_rate) {
        s_offset_n++;
    }
    s_offset_ns = s_offset_n == 1 ? envelope : s_offset_ns + (envelope - s_offset_ns) / s_offset_n;

    if (s_hist_len == HISTORY) {
        memmove(&s_hist[0], &s_hist[1], sizeof(s_hist[0]) * (HISTORY - 1));
        s_hist_len--;
    }
    input_t *cur = &s_hist[s_hist_len++];
    cur->t_ns = s_sensor_ns + s_offset_ns;
    memcpy(cur->samples, in->samples, sizeof(cur->samples));

    /* 3. Emit grid points with TAPS/2 inputs on each side, once the input
     * rate is known (the first RATE_BASELINE_US of a session is dropped). */
    if (!s_rate_measured || s_hist_len < HISTORY) {
        return 0;
    }
    const input_t *b = &s_hist[LEFT], *c = &s_hist[LEFT + 1];
    if (!s_have_grid) {
        s_have_grid = true;
        s_grid0_ns = b->t_ns;
        s_grid_k = 0;
    }
    unsigned n = 0;
    while (n < max) {
        double t = grid_time(s_grid_k);
        if (t > c->t_ns) {
            break;  /* wait for the next input */
        }
        if (t < b->t_ns) {
            s_grid_k++;  /* only right after a grid restart */
            continue;
        }
        double w[TAPS];
        lagrange_weights((t - b->t_ns) / (c->t_ns - b->t_ns), w);
        resample_out_t *o = &out[n++];
        memset(&o->frame, 0, sizeof(o->frame));
        o->frame.magic = ADS8688_STREAM_MAGIC;
        o->frame.version = ADS8688_STREAM_VERSION;
        o->frame.headerBytes = offsetof(Ads8688StreamFrame, samples);
        o->frame.sequence = s_out_seq++;
        o->frame.timestampUs = (uint64_t)(t / 1000.0);
        o->frame.scanRateHz = s_out_rate;
        o->frame.channelCount = ADS8688_STREAM_CHANNELS;
        o->frame.sampleFormat = ADS8688_STREAM_SAMPLE_U16;
        for (unsigned ch = 0; ch < ADS8688_STREAM_CHANNELS; ch++) {
            double v = 0;
            for (int j = 0; j < TAPS; j++) {
                v += w[j] * s_hist[j].samples[ch];
            }
            o->frame.samples[ch] = v < 0 ? 0 : v > 65535 ? 65535 : (uint16_t)lround(v);
        }
        o->unix_ns = (uint64_t)llround(t);
        s_grid_k++;
    }
    return n;
}
