#include <math.h>
#include <stdbool.h>
#include <string.h>

#include "anomaly.h"

#define VOLTS_PER_CODE (20.48f / 65536.0f)  /* same scale as the collector */
#define MID_SCALE_CODE 32768
#define HYSTERESIS     0.8f

typedef struct {
    float mean;
    float p_short;
    float p_long;
    anomaly_channel_t out;
} channel_t;

static anomaly_config_t s_cfg;
static unsigned s_channels;
static channel_t s_ch[ADS8688_STREAM_CHANNELS];
static uint32_t s_rate_hz;
static float s_a_short;
static float s_a_long;
static uint32_t s_samples;
static uint32_t s_warmup_samples;
static bool s_changed;

void anomaly_init(const anomaly_config_t *cfg, unsigned channels)
{
    s_cfg = *cfg;
    s_channels = channels > ADS8688_STREAM_CHANNELS ? ADS8688_STREAM_CHANNELS : channels;
    anomaly_reset();
}

void anomaly_reset(void)
{
    memset(s_ch, 0, sizeof(s_ch));
    s_rate_hz = 0;
    s_samples = 0;
}

static float alpha(float tau_s, uint32_t rate_hz)
{
    return 1.0f - expf(-1.0f / (tau_s * (float)rate_hz));
}

static anomaly_state_t classify(anomaly_state_t prev, float ratio)
{
    float warn = s_cfg.warn_ratio, alarm = s_cfg.alarm_ratio;
    if (ratio >= alarm || (prev == ANOMALY_ALARM && ratio >= alarm * HYSTERESIS)) {
        return ANOMALY_ALARM;
    }
    if (ratio >= warn || (prev >= ANOMALY_WARNING && ratio >= warn * HYSTERESIS)) {
        return ANOMALY_WARNING;
    }
    return ANOMALY_NORMAL;
}

void anomaly_update(const Ads8688StreamFrame *frame, uint64_t unix_ms)
{
    if (s_channels == 0 || frame->scanRateHz == 0) {
        return;
    }
    if (frame->scanRateHz != s_rate_hz) {
        anomaly_reset();
        s_rate_hz = frame->scanRateHz;
        s_a_short = alpha(s_cfg.short_tau_s, s_rate_hz);
        s_a_long = alpha(s_cfg.long_tau_s, s_rate_hz);
        s_warmup_samples = (uint32_t)(s_cfg.long_tau_s * (float)s_rate_hz);
    }
    bool warm = s_samples >= s_warmup_samples;
    float floor2 = s_cfg.rms_floor_v * s_cfg.rms_floor_v;

    for (unsigned ch = 0; ch < s_channels; ch++) {
        channel_t *c = &s_ch[ch];
        float x = ((int32_t)frame->samples[ch] - MID_SCALE_CODE) * VOLTS_PER_CODE;
        if (s_samples == 0) {
            c->mean = x;  /* start at the DC level instead of ramping from 0 */
        }
        c->mean += s_a_long * (x - c->mean);
        float d = x - c->mean, d2 = d * d;
        c->p_short += s_a_short * (d2 - c->p_short);
        c->p_long += s_a_long * (d2 - c->p_long);

        c->out.rms_short_v = sqrtf(c->p_short);
        c->out.rms_long_v = sqrtf(c->p_long);
        c->out.ratio = sqrtf(c->p_short / fmaxf(c->p_long, floor2));

        anomaly_state_t next = warm ? classify(c->out.state, c->out.ratio) : ANOMALY_WARMUP;
        if (next != c->out.state) {
            if (next >= ANOMALY_WARNING && c->out.state < ANOMALY_WARNING) {
                c->out.events++;
            }
            c->out.state = next;
            c->out.changed_unix_ms = unix_ms;
            s_changed = true;
        }
    }
    if (s_samples < UINT32_MAX) {
        s_samples++;
    }
}

void anomaly_get_config(anomaly_config_t *out)
{
    *out = s_cfg;
}

unsigned anomaly_channels(void)
{
    return s_channels;
}

void anomaly_get_channel(unsigned ch, anomaly_channel_t *out)
{
    *out = s_ch[ch < s_channels ? ch : 0].out;
}

bool anomaly_take_changed(void)
{
    bool changed = s_changed;
    s_changed = false;
    return changed;
}

anomaly_state_t anomaly_overall(void)
{
    anomaly_state_t worst = ANOMALY_WARMUP;
    for (unsigned ch = 0; ch < s_channels; ch++) {
        if (s_ch[ch].out.state > worst) {
            worst = s_ch[ch].out.state;
        }
    }
    return worst;
}

const char *anomaly_state_name(anomaly_state_t state)
{
    switch (state) {
    case ANOMALY_NORMAL:
        return "normal";
    case ANOMALY_WARNING:
        return "warning";
    case ANOMALY_ALARM:
        return "alarm";
    default:
        return "warmup";
    }
}
