# R5F ADS8688 relay

This firmware runs on MAIN R5FSS0-0 (the `remoteprocN` number is not stable). It receives fixed-size,
CRC-protected ADS8688 frames from the M4F on RPMsg endpoint 40 and forwards
valid frames to Linux through the standard `rpmsg_chrdev` service on endpoint
14.

Linux must open `/dev/rpmsg1` and write one subscription message before frames
are forwarded. The firmware replies with `ADS8OK`, then emits 48-byte stream
frames.

It also forwards versioned control packets from Linux to the M4F and returns
their ACKs. Control ACK delivery is blocking/guaranteed; stream data remains
non-blocking so a slow Linux consumer cannot deadlock the real-time cores.

Build with:

```powershell
.\build.ps1
```

Linux remoteproc consumes `ti-arm-clang/r5_ads8688_relay.release.out` directly.
