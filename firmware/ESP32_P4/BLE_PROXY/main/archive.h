/*
 * In-memory record ring (normally in PSRAM) behind ARCHIVE_INFO and
 * READ_BACKLOG, so the collector can replay what it missed while the
 * network or the server was down. Like the AM6442 ring it keeps the
 * newest records and drops the oldest when full; unlike it, the ring
 * does not survive a reboot.
 *
 * Records are stored compactly (only the advertised channels) and
 * rebuilt into full 48-byte stream frames on read. Record ids must be
 * appended consecutively; a jump restarts the ring.
 *
 * Not thread-safe: the DAQ server task is the only user.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ads8688_stream.h"

typedef struct {
    bool enabled;
    uint64_t earliest;   /* valid when count > 0 */
    uint64_t latest;     /* valid when count > 0 */
    uint32_t count;
    uint32_t capacity;
    size_t record_bytes;
} archive_info_t;

/* Bytes one record takes for `channels` stored samples. */
size_t archive_record_bytes(unsigned channels);

/* Use `buf` (`bytes` long) as the ring, storing the first `channels`
 * samples of each frame. A NULL buffer leaves the archive disabled. */
void archive_init(void *buf, size_t bytes, unsigned channels);

void archive_append(uint64_t record_id, uint64_t unix_ns, const Ads8688StreamFrame *frame);

void archive_get_info(archive_info_t *out);

/* Rebuild record `record_id`. Returns false if it is not (or no longer)
 * stored. Samples beyond the stored channels read as mid-scale. */
bool archive_read(uint64_t record_id, uint64_t *unix_ns, Ads8688StreamFrame *frame);
