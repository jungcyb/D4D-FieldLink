"use client";
import type {SensorView} from "@/lib/types";
import Dialog from "./dialog";
import AnomalyTrainingWorkspace from "./anomaly-training-workspace";
export default function TrainingReadinessDialog({sensor,onClose}:{sensor:SensorView;onClose:()=>void}){
  return <Dialog title="정상 기간 승인·이상 탐지 학습" subtitle={`${sensor.name} · ${sensor.channel}`} onClose={onClose} wide><AnomalyTrainingWorkspace sensor={sensor}/></Dialog>;
}
