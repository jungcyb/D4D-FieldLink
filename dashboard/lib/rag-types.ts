import type {Daq,Equipment,Sensor,Diagnosis,Mode,Severity} from "./types";
import type {ConnectionRecord,Dependency,Incident,DeviceImpact} from "./operations-types";
export interface RagSelection {daqUuid:string;sensorIds:string[];batchesPerSensor:number;includeRawPreview:boolean}
export interface RagBatch {id:string;sensorId:string;channel:string;timestamp:string;endTimestamp:string;sps:number;value:number;unit:string;sampleCount:number;source:Mode;rawSummary:{min:number;max:number;mean:number;rms:number}|null;rawPreview?:{index:number;value:number}[]}
export interface RagContext {
  capturedAt:string;mode:Mode;daq:Daq;equipment:Equipment|null;sensors:Sensor[];
  status:{daqOnline:boolean;heartbeatAgeMs:number;connection:ConnectionRecord|null;equipmentSeverity:Severity|"unknown";dependencyImpact:DeviceImpact|null;sensors:{sensorId:string;online:boolean;severity:Severity|"unknown";latestValue:number|null;latestTimestamp:string|null;dataAgeMs:number|null;diagnosis:Diagnosis|null}[]};
  placement:{equipmentLocation:string|null;sensors:{sensorId:string;channel:string;position:string;photoRef:string|null}[]};
  batches:RagBatch[];
  coverage:{batchesPerSensor:number;rawPreviewIncluded:boolean;rawPreviewLimitPerBatch:number;perSensor:{sensorId:string;availableBatches:number;includedBatches:number;from:string|null;to:string|null}[]};
  related:{equipment:{id:string;name:string;severity:Severity|"unknown";online:boolean}[];dependencies:Dependency[];incidents:Pick<Incident,"id"|"title"|"status"|"rootEquipmentIds"|"affectedEquipmentIds">[];logs:{id:string;timestamp:string;code:string;level:string;source:string;message:string}[]};
}
export interface RagEnvelope {schemaVersion:"fieldlink.rag.v1";selection:RagSelection;context:RagContext}
export interface RagCitation {id:string;title:string;source:string|null;excerpt:string|null;sensorId:string|null;batchId:string|null}
export interface RagResult {answer:string;citations:RagCitation[];model:string|null;requestId:string;contextCapturedAt:string;respondedAt:string;selection:RagSelection;contextStats:{sensors:number;batches:number;bytes:number}}
export interface RagHistoryMessage {role:"user"|"assistant";content:string;daqUuid?:string;sensorIds?:string[]}
export interface RagConfig {configured:boolean;protocol:"fieldlink.rag.v1";timeoutMs:number;maxSensors:number;maxBatchesPerSensor:number}
