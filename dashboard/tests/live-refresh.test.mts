import test from "node:test";
import assert from "node:assert/strict";
import {setTimeout as sleep} from "node:timers/promises";
import {eventResponse,publishUpdate} from "../lib/server/live-events.ts";
import {refreshLoop} from "../lib/refresh-loop.ts";

test("SSE sends committed update notices immediately and cleans up on cancellation",async()=>{
  const abort=new AbortController(),response=eventResponse(abort.signal),reader=response.body!.getReader(),decode=new TextDecoder();
  assert.match(response.headers.get("content-type")!,/text\/event-stream/);
  assert.match(decode.decode((await reader.read()).value),/event: ready/);
  const started=performance.now();publishUpdate("diagnoses");
  assert.match(decode.decode((await reader.read()).value),/"topic":"diagnoses"/);
  assert.ok(performance.now()-started<500,"no polling delay is inserted");
  abort.abort();assert.equal((await reader.read()).done,true);
  assert.doesNotThrow(()=>publishUpdate("logs"));
});

test("slow SSE readers are bounded and reconnect rather than buffering forever",async()=>{
  const reader=eventResponse(new AbortController().signal).body!.getReader();
  for(let i=0;i<100;i++)publishUpdate("telemetry");
  let chunks=0;while(!(await reader.read()).done)chunks++;
  assert.ok(chunks<=64);await reader.cancel();
});

test("refresh coalesces bursts and preserves an event arriving during the active request",async()=>{
  let calls=0,active=0,maxActive=0,release!:()=>void;
  const first=new Promise<void>(resolve=>{release=resolve;});
  const loop=refreshLoop(async()=>{calls++;active++;maxActive=Math.max(maxActive,active);if(calls===1)await first;active--;},5);
  const initial=loop.request();for(let i=0;i<20;i++)void loop.request();
  await sleep(20);assert.equal(calls,1);
  const next=loop.request();release();await initial;await next;
  assert.equal(calls,2);assert.equal(maxActive,1);loop.stop();
});

test("unmount cancels pending refreshes and aborts in-flight requests",async()=>{
  let calls=0,signal:AbortSignal|undefined;
  const loop=refreshLoop(async s=>{calls++;signal=s;},5);
  await loop.request();loop.stop();assert.equal(signal?.aborted,true);
  await loop.request();await sleep(15);assert.equal(calls,1);
  const pending=refreshLoop(async()=>{calls++;},50);const request=pending.request();pending.stop();await request;await sleep(60);assert.equal(calls,1);
});
