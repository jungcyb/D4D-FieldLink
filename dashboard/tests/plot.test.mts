import {test} from "node:test";
import assert from "node:assert/strict";
import {fitRange,nearestPoint,valueDomain,formatValue} from "../lib/plot.ts";
test("plot zoom and pan stay bounded, including empty and single sample",()=>{
  assert.deepEqual(fitRange(-50,50,1000),[0,100]);
  assert.deepEqual(fitRange(950,1050,1000),[899,999]);
  assert.deepEqual(fitRange(0,2000,1000),[0,999]);
  assert.deepEqual(fitRange(0,0,1),[0,1]);
  assert.deepEqual(fitRange(0,0,0),[0,1]);
});
test("hover returns actual retained index, never interpolated or invented values",()=>{
  const points=[{index:0,value:-2},{index:5,value:10},{index:100,value:-5}];
  assert.equal(nearestPoint(points,40),points[1]);assert.equal(nearestPoint(points,90),points[2]);
  assert.equal(nearestPoint(points,-20),points[0]);assert.equal(nearestPoint(points,200),points[2]);assert.equal(nearestPoint([],1),undefined);
});
test("autoscale handles constant, negative and tiny signals without hiding precision",()=>{
  for(const value of [0,-1,10.2396875]){const domain=valueDomain([{index:0,value}]);assert.ok(domain[0]<value&&domain[1]>value);}
  const domain=valueDomain([{index:0,value:.001},{index:1,value:.0011}]);assert.ok(domain[1]-domain[0]<.0002);
  assert.notEqual(formatValue(.001),formatValue(.0011));assert.deepEqual(valueDomain([]),[-1,1]);
});
