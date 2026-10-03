// public/audio-worklet-processor.js
class AudioRingBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.port.onmessage = (e) => {
      const { type, data } = e.data || {};
      if (type === 'push') {
        const chunk = data;
        if (!chunk) return;
        this._chunks.push(chunk);
        this._totalSamples += chunk.numberOfFrames || 0;
      } else if (type === 'flush') {
        this._chunks.length = 0;
        this._read = 0;
        this._totalSamples = 0;
        this._playhead = 0;
        this._started = false;
      } else if (type === 'setBase') {
        this._baseTime = data.baseTime || 0;
        this._started = false;
        this._playhead = 0;
      }
    };
    this._chunks = [];
    this._read = 0;
    this._totalSamples = 0;
    this._playhead = 0;
    this._baseTime = 0;
    this._started = false;
    this._lowWater = 2048;
    this._highWater = 8192 * 2;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channels = output.length;
    const frames = output[0].length;
    let written = 0;

    while (written < frames) {
      if (this._read >= this._chunks.length) break;
      const c = this._chunks[this._read];
      const remInChunk = (c.numberOfFrames || 0) - this._playhead;
      if (remInChunk <= 0) {
        this._read++;
        this._playhead = 0;
        continue;
      }
      const take = Math.min(remInChunk, frames - written);
      for (let ch = 0; ch < channels; ch++) {
        const src = c.getChannelData(ch);
        const dst = output[ch];
        for (let i = 0; i < take; i++) {
          dst[written + i] = src[this._playhead + i];
        }
      }
      this._playhead += take;
      written += take;
      this._totalSamples -= take;
    }

    if (written < frames) {
      const fill = frames - written;
      for (let ch = 0; ch < channels; ch++) {
        const dst = output[ch];
        for (let i = 0; i < fill; i++) dst[written + i] = 0;
      }
    }

    const buffered = this._totalSamples;
    if (!this._started && buffered >= this._lowWater) {
      this._started = true;
      this.port.postMessage({ type: 'ready', baseTime: this._baseTime });
    }
    if (buffered > this._highWater * 2 && this._chunks.length > 1) {
      const c0 = this._chunks.shift();
      this._read = Math.max(0, this._read - 1);
      this._totalSamples -= (c0.numberOfFrames || 0) - this._playhead;
      this._playhead = 0;
    }

    return true;
  }
}
registerProcessor('audio-ring-buffer', AudioRingBufferProcessor);
