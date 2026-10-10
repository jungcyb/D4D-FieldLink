export interface PredictionUnavailable { status: "unavailable" | "error"; reason: string }
export type AnomalyDetection = PredictionUnavailable | { status: "ok"; profile_id: string; model_version: string; anomaly_score: number; threshold: number; is_anomaly: boolean };
export type RulPrediction = (PredictionUnavailable & { estimated_rul_hours: null }) | { status: "available"; estimated_rul_hours: number; uncertainty_status: string };
export type FaultClassification = PredictionUnavailable | { status: "ok"; predicted_class: string; probabilities: Record<string, number>; probabilities_calibrated: boolean };
export interface EdgeSensorPrediction { profile_id: string; anomaly_detection: AnomalyDetection; rul: RulPrediction; fault_classification: FaultClassification }
export interface EquipmentPrediction { schema_version: "edge_prediction_v0.3"; timestamp: string; equipment_rul: { status: "unavailable"; reason: string }; maintenance_priority: { status: "not_computed"; owner: "backend_policy" } }
