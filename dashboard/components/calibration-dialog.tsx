"use client";

import { useState } from "react";
import type { Reading, Sensor, SensorView } from "@/lib/types";
import { api, send } from "@/lib/client-api";
import Dialog from "./dialog";
import Icon from "./icons";

const finite = (value: string) => value.trim() !== "" && Number.isFinite(Number(value));
const coefficient = (value: number) => Number(value.toPrecision(12)).toString();

export default function CalibrationDialog({ sensor, onClose, onSaved, toast }: { sensor: SensorView; onClose: () => void; onSaved: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [scale, setScale] = useState(coefficient(sensor.calibration.scale));
  const [offset, setOffset] = useState(coefficient(sensor.calibration.offset));
  const [inputUnit, setInputUnit] = useState(sensor.calibration.inputUnit);
  const [inputA, setInputA] = useState(""); const [referenceA, setReferenceA] = useState("");
  const [inputB, setInputB] = useState(""); const [referenceB, setReferenceB] = useState("");
  const [currentInput, setCurrentInput] = useState<number | null>(sensor.latest?.sourceValue ?? null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");

  async function capture(point: "A" | "B") {
    setBusy(true); setError("");
    try {
      const rows = await api<Reading[]>(`/sensors/${sensor.id}/telemetry?limit=5&raw=false&calibrated=false`);
      if (!rows.length) throw new Error("캡처할 입력 데이터가 아직 없습니다.");
      const average = rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
      setCurrentInput(average);
      if (point === "A") setInputA(coefficient(average)); else setInputB(coefficient(average));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "현재값 캡처에 실패했습니다."); }
    finally { setBusy(false); }
  }

  function calculate() {
    setError("");
    if (![inputA, referenceA, inputB, referenceB].every(finite)) { setError("두 기준점의 입력값과 기준값을 모두 입력해 주세요."); return; }
    const x1 = Number(inputA), y1 = Number(referenceA), x2 = Number(inputB), y2 = Number(referenceB);
    if (Math.abs(x2 - x1) < 1e-12) { setError("서로 다른 두 입력값이 필요합니다."); return; }
    const nextScale = (y2 - y1) / (x2 - x1);
    setScale(coefficient(nextScale)); setOffset(coefficient(y1 - nextScale * x1));
  }

  async function save() {
    setError("");
    if (!finite(scale) || !finite(offset) || Math.abs(Number(scale)) < 1e-12) { setError("유효한 scale과 offset을 입력해 주세요. scale은 0일 수 없습니다."); return; }
    if (!inputUnit.trim()) { setError("입력 단위를 입력해 주세요."); return; }
    setBusy(true);
    try {
      await send<Sensor>(`/sensors/${sensor.id}/calibration`, { scale: Number(scale), offset: Number(offset), inputUnit: inputUnit.trim() }, "PATCH");
      await onSaved(); toast("채널 보정을 저장했습니다. 원본 수집 데이터는 변경하지 않았습니다."); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "보정 저장에 실패했습니다."); }
    finally { setBusy(false); }
  }

  const preview = currentInput != null && finite(scale) && finite(offset) ? currentInput * Number(scale) + Number(offset) : null;
  return <Dialog title={`${sensor.name} 보정`} subtitle={`${sensor.channel} · physical = input × scale + offset`} onClose={onClose} busy={busy} wide>
    <div className="calibration-layout">
      <section className="calibration-points">
        <div className="calibration-intro"><Icon name="info" size={17}/><p>서로 다른 두 기준값을 인가한 뒤 현재 평균값을 캡처하세요. 캡처는 최근 5개 배치의 대표 입력값을 평균냅니다.</p></div>
        {(["A", "B"] as const).map(point => <div className="calibration-point" key={point}>
          <strong>기준점 {point}</strong>
          <label>DAQ 입력값 ({inputUnit || "입력 단위"})<input type="number" step="any" value={point === "A" ? inputA : inputB} onChange={event => point === "A" ? setInputA(event.target.value) : setInputB(event.target.value)}/></label>
          <button type="button" className="button secondary small" disabled={busy} onClick={() => void capture(point)}><Icon name="pulse" size={14}/>현재 평균값 캡처</button>
          <label>실제 기준값 ({sensor.unit})<input type="number" step="any" value={point === "A" ? referenceA : referenceB} onChange={event => point === "A" ? setReferenceA(event.target.value) : setReferenceB(event.target.value)}/></label>
        </div>)}
        <button type="button" className="button secondary full" onClick={calculate}>두 점으로 계수 계산</button>
      </section>
      <section className="calibration-result">
        <p className="eyebrow">AFFINE TRANSFORM</p><h3>보정 계수</h3>
        <label>입력 단위<input value={inputUnit} maxLength={20} onChange={event => setInputUnit(event.target.value)} placeholder="예: V"/></label>
        <div className="form-grid"><label>Scale<input type="number" step="any" value={scale} onChange={event => setScale(event.target.value)}/></label><label>Offset<input type="number" step="any" value={offset} onChange={event => setOffset(event.target.value)}/></label></div>
        <div className="calibration-equation"><code>{sensor.unit} = {scale || "?"} × {inputUnit || "input"} + {offset || "?"}</code><small>음수 scale은 센서 방향을 반전합니다. 현재 기본값은 자동으로 바꾸지 않습니다.</small></div>
        <div className="calibration-preview"><span>현재 입력</span><strong>{currentInput == null ? "데이터 대기" : `${currentInput.toFixed(6)} ${inputUnit}`}</strong><span>보정 미리보기</span><strong>{preview == null ? "—" : `${preview.toFixed(6)} ${sensor.unit}`}</strong></div>
        <button type="button" className="text-link" onClick={() => { setScale("1"); setOffset("0"); }}>계수를 1 / 0으로 초기화</button>
      </section>
    </div>
    {error && <div className="form-error" role="alert"><Icon name="warning" size={16}/>{error}</div>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>취소</button><button type="button" className="button primary" onClick={() => void save()} disabled={busy}>{busy ? "처리 중…" : "보정 저장"}<Icon name="check" size={17}/></button></div>
  </Dialog>;
}
