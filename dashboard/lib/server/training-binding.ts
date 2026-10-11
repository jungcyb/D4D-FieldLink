import {createHash} from "node:crypto";
import type {Sensor,Daq} from "../types.ts";
import type {TrainingBinding} from "../training-types.ts";
export function sensorBinding(sensor:Sensor,daq:Daq):TrainingBinding{
  return{sensorId:sensor.id,daqUuid:daq.uuid,equipmentId:daq.equipmentId,channel:sensor.channel,type:sensor.type,position:sensor.position,inputUnit:sensor.calibration.inputUnit,unit:sensor.unit,scale:sensor.calibration.scale,offset:sensor.calibration.offset};
}
/** Backend metadata binding, separate from the learner's SensorConfig configuration_hash. */
export function bindingHash(binding:TrainingBinding):string{return createHash("sha256").update(JSON.stringify(binding)).digest("hex");}
