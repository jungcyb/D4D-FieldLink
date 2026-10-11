export type TrainingStatus="queued"|"training"|"candidate"|"activation_requested"|"active"|"superseded"|"failed";
export interface TrainingBinding {sensorId:string;daqUuid:string;equipmentId:string|null;channel:string;type:string;position:string;inputUnit:string;unit:string;scale:number;offset:number}
export interface CandidateReport {
  modelVersion:string;profileId:string;configurationHash:string;threshold:number;
  normalTestFalseAlarmRate:number;datasetDigest:string;
  splits:Record<"train"|"calibration"|"test",{windows:number;sessions:string[];files:string[]}>;
}
export interface TrainingJob {
  id:string;sensorId:string;daqUuid:string;approvalId:string;from:string;to:string;
  status:TrainingStatus;binding:TrainingBinding;bindingHash:string;createdAt:string;updatedAt:string;
  candidate:CandidateReport|null;error:string|null;activationRequestId:string|null;
  requestedAction:"activate"|"rollback"|null;previousActiveId:string|null;demo:boolean;
}
export interface CandidateSummary extends Omit<CandidateReport,"splits"> {splits:Record<"train"|"calibration"|"test",{windows:number;sessionCount:number}>}
export interface TrainingJobSummary extends Omit<TrainingJob,"candidate"> {candidate:CandidateSummary|null}
export interface TrainingHistory {currentBindingHash:string;jobs:TrainingJobSummary[];approvals:{id:string;from:string;to:string;approvedAt:string;bindingHash?:string}[];executionOwner:"daq"}
