"""Resource-paced v0.4 inference, isolated from DAQ I/O by one worker process.

One in-flight window, no accumulating inference backlog. Each completion permits
the next newest complete window; models share the worker round-robin. Raw ring
storage is independent and never drops samples because inference is busy.
"""
from collections import deque
import json
import multiprocessing as mp
from pathlib import Path
import queue
import struct
import sys
import time


def _worker(config_path, jobs, results):
    # Heavy dependencies and model loading stay out of the acquisition process.
    import os
    for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
        os.environ[key] = '1'
    export = Path(__file__).resolve().parents[1] / 'anamolydetection' / 'v0.4_export'
    sys.path.insert(0, str(export))
    from activation import load_active_candidate
    from edge_config import SensorConfig
    from window_builder import RawChunk, WindowBuilder
    import numpy as np

    models = {}
    try:
        entries = json.loads(Path(config_path).read_text(encoding='utf-8'))
        if not isinstance(entries, list) or not 1 <= len(entries) <= 8:
            raise ValueError('one to eight activated ADS8688 sensor models required')
        for entry in entries:
            config = SensorConfig.from_mapping(entry['config'])
            if any(c not in [f'CH{i}' for i in range(8)] for c in config.channels):
                raise ValueError('ADS8688 models may only use CH0..CH7')
            if config.sensor_id in models:
                raise ValueError('duplicate sensor model')
            if config.max_sampling_rate_hz > 2000 or config.window_seconds * config.max_sampling_rate_hz > 120000:
                raise ValueError('model window exceeds bounded acquisition memory')
            activation = Path(config_path).resolve().parent / entry['activation']
            models[config.sensor_id] = (config, load_active_candidate(activation, config))
        results.put({'kind': 'ready', 'models': [c.canonical_mapping() for c, _ in models.values()]})
    except Exception as error:
        results.put({'kind': 'error', 'error': str(error)})
        return
    while True:
        job = jobs.get()
        if job is None:
            return
        started = time.monotonic()
        config, scorer = models[job['sensor_id']]
        try:
            builder = WindowBuilder(config)
            windows, errors = builder.ingest(RawChunk(np.asarray(job['samples'], dtype=float), job['rate'],
                job['sequence'], job['timestamp'], config.configuration_hash))
            if errors or not windows:
                raise ValueError(str(errors or 'incomplete window'))
            window = windows[-1]
            verdict = scorer.score(window.samples, window.sampling_rate_hz, window.timestamps)
            result = {'status': 'ok', 'anomaly_detection': verdict}
        except Exception as error:
            result = {'status': 'error', 'reason': str(error)}
        results.put({'kind': 'result', 'sensor_id': config.sensor_id, 'daq_uuid': config.daq_uuid,
                     'channels': list(config.channels), 'configuration_hash': config.configuration_hash,
                     'window_start_timestamp_s': job['timestamp'],
                     'window_end_timestamp_s': job['timestamp'] + (len(job['samples']) - 1) / job['rate'],
                     'sequence_start': job['sequence'], 'sampling_rate_hz': job['rate'],
                     'inference_ms': (time.monotonic() - started) * 1000, **result})


class Inference:
    def __init__(self, config_path, identity):
        context = mp.get_context('spawn')
        self.jobs, self.results = context.Queue(1), context.Queue(2)
        self.process = context.Process(target=_worker, args=(str(config_path), self.jobs, self.results), daemon=True)
        self.identity = str(identity)
        self.models = []
        self.rows = deque(maxlen=1)
        self.epoch = None
        self.rate = None
        self.next_sequence = None
        self.busy = False
        self.cursor = 0
        self.last_submitted = {}
        self.state = {'state': 'loading', 'windows_scored': 0, 'input_resets': 0, 'scheduling': 'latest_complete_window_on_worker_ready'}
        self.process.start()

    def poll(self):
        output = []
        while True:
            try:
                result = self.results.get_nowait()
            except queue.Empty:
                break
            if result['kind'] == 'ready':
                self.models = result['models']
                if any(c['daq_uuid'] != self.identity for c in self.models):
                    self.state.update(state='error', error='activation belongs to another DAQ')
                    self.models = []
                else:
                    self.rows = deque(maxlen=max(round(c['window_seconds'] * c['max_sampling_rate_hz']) for c in self.models))
                    self.state['state'] = 'warming_up'
            elif result['kind'] == 'error':
                self.state.update(state='error', error=result['error'])
            else:
                self.busy = False
                self.state.update(state='running', last_inference_ms=result['inference_ms'])
                self.state['windows_scored'] += int(result['status'] == 'ok')
                output.append(result)
        if not self.process.is_alive() and self.state['state'] != 'error':
            self.state.update(state='error', error='inference worker exited')
        return output

    def feed(self, frame, received_ns):
        _, _, _, seq, _device_us, rate, _, _, *tail = struct.unpack('<IHHIQIHH8HI', frame)
        if self.rate != rate or self.next_sequence is not None and seq != self.next_sequence:
            self.rows.clear()
            self.epoch = (seq, received_ns / 1e9)
            self.last_submitted.clear()
            self.state['input_resets'] += 1
        self.rate, self.next_sequence = rate, (seq + 1) & 0xffffffff
        self.rows.append((seq, [code * 20.48 / 65536 - 10.24 for code in tail[:8]]))
        if self.busy or not self.models:
            return
        for offset in range(len(self.models)):
            index = (self.cursor + offset) % len(self.models)
            config = self.models[index]
            count = round(config['window_seconds'] * rate)
            if not config['min_sampling_rate_hz'] <= rate <= config['max_sampling_rate_hz']:
                self.state.update(state='incompatible_rate', error='sampling rate changed; retrain/reactivate matching model')
                continue
            if len(self.rows) < count or self.last_submitted.get(config['sensor_id']) == seq:
                continue
            rows = list(self.rows)[-count:]
            channels = [int(c[2:]) for c in config['channels']]
            timestamp = self.epoch[1] + ((rows[0][0] - self.epoch[0]) & 0xffffffff) / rate
            self.jobs.put_nowait({'sensor_id': config['sensor_id'], 'sequence': rows[0][0], 'rate': rate,
                                 'timestamp': timestamp, 'samples': [[r[1][i] for i in channels] for r in rows]})
            self.busy = True
            self.last_submitted[config['sensor_id']] = seq
            self.cursor = (index + 1) % len(self.models)
            break

    def close(self):
        try:
            self.jobs.put_nowait(None)
        except queue.Full:
            pass
        self.process.join(timeout=2)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=2)
        self.jobs.close()
        self.results.close()
