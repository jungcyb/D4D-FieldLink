import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,join,resolve} from "node:path";
import {configuredMode,FileRepository} from "../lib/server/repository.ts";

test("Next development defaults to mock data; production and other runtimes use real data",()=>{
  assert.equal(configuredMode({NODE_ENV:"development"}),"demo");
  assert.equal(configuredMode({NODE_ENV:"production"}),"external");
  assert.equal(configuredMode({NODE_ENV:"test"}),"external");
  assert.equal(configuredMode({}),"external");
  assert.equal(configuredMode({NODE_ENV:"development",DAQ_MODE:""}),"demo");
});
test("explicit DAQ_MODE overrides the automatic runtime mode",()=>{
  assert.equal(configuredMode({NODE_ENV:"development",DAQ_MODE:"external"}),"external");
  assert.equal(configuredMode({NODE_ENV:"production",DAQ_MODE:"demo"}),"demo");
});
test("development mock devices never seed or overwrite the production store",t=>{
  const directory=mkdtempSync(join(tmpdir(),"fieldlink-mode-test-"));
  t.after(()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir()))&&basename(directory).startsWith("fieldlink-mode-test-"));rmSync(directory,{recursive:true,force:true});});
  const development=new FileRepository(directory,configuredMode({NODE_ENV:"development"}));
  const production=new FileRepository(directory,configuredMode({NODE_ENV:"production"}));
  assert.ok(development.read().daqs.length>0);assert.ok(development.read().sensors.length>0);
  assert.equal(production.read().daqs.length,0);assert.equal(production.read().sensors.length,0);
  assert.notEqual(development.filename,production.filename);
  assert.ok(development.read().sensors.length>0);
});
