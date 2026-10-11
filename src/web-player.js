// ═══════════════════════════════════════════════════════
// web-player.js — 基于 web-demuxer + MSE 的播放器
//
// 用 web-demuxer 解封装（mkv/ts/flv/avi…），将编码包封装成 fMP4，
// 通过 MediaSourceExtensions 喂给现有 <video> 元素。
//
// 主路线仍是 HTML5 <video>，此模块只为浏览器不支持的容器拓展格式。
// 浏览器不支持的编码（RV40/VC-1 等）回退到 ffmpeg+mpv 路径。
// ═══════════════════════════════════════════════════════

import { WebDemuxer, AVMediaType } from './vendor/web-demuxer.js';
import { buildInitSegment, buildMediaSegment, codecString, VIDEO_TIMESCALE } from './fmp4-muxer.js';
import { convertFileSrc, invoke } from './vendor/core.js';

// web-demuxer WASM 路径（与 JS 同目录）
const WASM_PATH = new URL('./vendor/web-demuxer.wasm', import.meta.url).href;

// 本地文件 HTTP 服务器端口（web-demuxer 的 worker 无法通过 asset 协议访问文件）
let _fileServerPort = 0;
async function fileServerPort() {
  if (_fileServerPort === 0) {
    try { _fileServerPort = await invoke('get_file_server_port'); } catch { _fileServerPort = 0; }
  }
  return _fileServerPort;
}

// 将本地文件路径转为 HTTP URL（base64 编码路径，避免特殊字符问题）
async function fileToHttpUrl(path) {
  const port = await fileServerPort();
  if (!port) return convertFileSrc(path); // 回退到 asset 协议
  const b64 = btoa(unescape(encodeURIComponent(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `http://127.0.0.1:${port}/${b64}`;
}

/**
 * 检测 h264 数据中的 NAL 类型。
 * 返回 { hasIdr, hasSps, hasPps }：IDR(type 5)、SPS(type 7)、PPS(type 8)。
 * 支持 Annex B 和 AVCC 格式。
 */
function analyzeH264Nals(data) {
  const result = { hasIdr: false, hasSps: false, hasPps: false };
  if (!data || data.length < 5) return result;
  const d = new Uint8Array(data);
  let i = 0;
  const n = d.length;
  while (i < n) {
    if (d[i] === 0 && d[i + 1] === 0) {
      if (d[i + 2] === 1) { i += 3; }
      else if (d[i + 2] === 0 && d[i + 3] === 1) { i += 4; }
      else {
        if (i + 4 > n) break;
        const len = (d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3];
        i += 4;
        if (i >= n) break;
        const t = d[i] & 0x1f;
        if (t === 5) result.hasIdr = true;
        if (t === 7) result.hasSps = true;
        if (t === 8) result.hasPps = true;
        i += len;
        continue;
      }
    } else {
      if (i + 4 > n) break;
      const len = (d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3];
      i += 4;
      if (i >= n) break;
      const t = d[i] & 0x1f;
      if (t === 5) result.hasIdr = true;
      if (t === 7) result.hasSps = true;
      if (t === 8) result.hasPps = true;
      i += len;
      continue;
    }
    if (i >= n) break;
    const t = d[i] & 0x1f;
    if (t === 5) result.hasIdr = true;
    if (t === 7) result.hasSps = true;
    if (t === 8) result.hasPps = true;
    i++;
    while (i < n - 3) {
      if (d[i] === 0 && d[i + 1] === 0 && (d[i + 2] === 1 || (d[i + 2] === 0 && d[i + 3] === 1))) break;
      i++;
    }
  }
  return result;
}

/**
 * 将 Annex B 格式的 h264 数据转换为 AVCC 格式（4 字节大端长度前缀）。
 * fMP4 的 mdat 中 h264 必须是 AVCC 格式。
 * 如果数据已经是 AVCC 格式（无前缀起始码），原样返回。
 */
function annexBToAvcc(data) {
  if (!data || data.length < 4) return data;
  const d = new Uint8Array(data);
  // 检测是否为 Annex B：开头是 00 00 00 01 或 00 00 01
  const isAnnexB = (d[0] === 0 && d[1] === 0 && d[2] === 1) ||
    (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 1);
  if (!isAnnexB) return data;

  // 找到所有 NAL unit
  const nals = [];
  let i = 0;
  const n = d.length;
  while (i < n) {
    // 跳过起始码
    let start = -1;
    if (d[i] === 0 && d[i + 1] === 0) {
      if (d[i + 2] === 1) { start = i + 3; }
      else if (d[i + 2] === 0 && d[i + 3] === 1) { start = i + 4; }
    }
    if (start < 0) break;
    // 找下一个起始码
    let end = n;
    for (let j = start; j < n - 3; j++) {
      if (d[j] === 0 && d[j + 1] === 0 && (d[j + 2] === 1 || (d[j + 2] === 0 && d[j + 3] === 1))) {
        end = j;
        break;
      }
    }
    nals.push(d.subarray(start, end));
    i = end;
  }
  // 拼接为 AVCC
  let total = 0;
  for (const nal of nals) total += 4 + nal.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const nal of nals) {
    const len = nal.length;
    out[off] = (len >>> 24) & 0xff;
    out[off + 1] = (len >>> 16) & 0xff;
    out[off + 2] = (len >>> 8) & 0xff;
    out[off + 3] = len & 0xff;
    out.set(nal, off + 4);
    off += 4 + len;
  }
  return out;
}

/**
 * 从 Annex B 格式的 h264 数据中提取 SPS 和 PPS，构建 avcC box 内容。
 * avcC 格式：version(1) + profile(1) + constraint(1) + level(1) +
 *            reserved(6)|lengthSizeMinusOne(2) + reserved(3)|numSPS(5) +
 *            spsLen(2) + SPS + numPPS(1) + ppsLen(2) + PPS
 */
function buildAvcCFromAnnexB(data) {
  const nals = [];
  const d = new Uint8Array(data);
  let i = 0;
  const n = d.length;
  while (i < n) {
    let start = -1;
    if (d[i] === 0 && d[i + 1] === 0) {
      if (d[i + 2] === 1) { start = i + 3; }
      else if (d[i + 2] === 0 && d[i + 3] === 1) { start = i + 4; }
    }
    if (start < 0) break;
    let end = n;
    for (let j = start; j < n - 3; j++) {
      if (d[j] === 0 && d[j + 1] === 0 && (d[j + 2] === 1 || (d[j + 2] === 0 && d[j + 3] === 1))) {
        end = j;
        break;
      }
    }
    nals.push(d.subarray(start, end));
    i = end;
  }
  let sps = null, pps = null;
  for (const nal of nals) {
    const t = nal[0] & 0x1f;
    if (t === 7 && !sps) sps = nal;
    if (t === 8 && !pps) pps = nal;
  }
  if (!sps) return null;
  const out = [];
  out.push(1); // configurationVersion
  out.push(sps[1]); // AVCProfileIndication
  out.push(sps[2]); // profile_compatibility
  out.push(sps[3]); // AVCLevelIndication
  out.push(0xff); // reserved(111111) + lengthSizeMinusOne(11) = 4 字节长度
  out.push(0xe1); // reserved(111) + numOfSequenceParameterSets(00001)
  out.push((sps.length >>> 8) & 0xff);
  out.push(sps.length & 0xff);
  for (let k = 0; k < sps.length; k++) out.push(sps[k]);
  out.push(pps ? 1 : 0); // numOfPictureParameterSets
  if (pps) {
    out.push((pps.length >>> 8) & 0xff);
    out.push(pps.length & 0xff);
    for (let k = 0; k < pps.length; k++) out.push(pps[k]);
  }
  return new Uint8Array(out);
}

/**
 * 检查指定编码是否被当前浏览器的 MSE 支持。
 */
export function isMseSupported(stream) {
  if (!stream) return false;
  const codec = codecString(stream);
  if (!codec) return false;
  const type = stream.codec_type === AVMediaType.AVMEDIA_TYPE_AUDIO ? 'audio' : 'video';
  const mime = `${type}/mp4; codecs="${codec}"`;
  try {
    return MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

/**
 * 探测文件的编码信息，返回是否可走 web-demuxer 路径。
 * @returns {Promise<{info: WebMediaInfo, canPlay: boolean, videoCodec: string, audioCodec: string}>}
 */
export async function probeFile(path) {
  let demuxer;
  try {
    demuxer = new WebDemuxer({ wasmFilePath: WASM_PATH });
    const url = await fileToHttpUrl(path);
    console.log('[web-demuxer] probe load:', url);
    await demuxer.load(url);
    const info = await demuxer.getMediaInfo();
    const videoStream = info.streams.find(s => s.codec_type === AVMediaType.AVMEDIA_TYPE_VIDEO);
    const audioStream = info.streams.find(s => s.codec_type === AVMediaType.AVMEDIA_TYPE_AUDIO);

    // TS 等容器的音频流参数可能探测不完整（sample_rate=0, channels=0），
    // 用 getDecoderConfig 获取 WebCodecs 配置中的完整参数
    if (audioStream) {
      try {
        const aCfg = await demuxer.getDecoderConfig('audio');
        if (aCfg) {
          if (!audioStream.sample_rate || audioStream.sample_rate === 0) audioStream.sample_rate = aCfg.sampleRate;
          if (!audioStream.channels || audioStream.channels === 0) audioStream.channels = aCfg.numberOfChannels;
          if (!audioStream.extradata && aCfg.description) audioStream.extradata = new Uint8Array(aCfg.description);
        }
      } catch (e) { console.warn('[web-demuxer] getDecoderConfig(audio) failed:', e); }
      // 最终兜底：TS 等容器可能探测不到音频参数
      if (!audioStream.sample_rate || audioStream.sample_rate === 0) audioStream.sample_rate = 44100;
      if (!audioStream.channels || audioStream.channels === 0) audioStream.channels = 2;
    }

    const videoOk = videoStream ? isMseSupported(videoStream) : false;
    const audioOk = audioStream ? isMseSupported(audioStream) : true;
    const vCodec = videoStream ? codecString(videoStream) : '(none)';
    const aCodec = audioStream ? codecString(audioStream) : '(none)';
    console.log(`[web-demuxer] probe result: video=${videoStream?.codec_name}(${vCodec}) mse=${videoOk}, audio=${audioStream?.codec_name}(${aCodec}) sr=${audioStream?.sample_rate} ch=${audioStream?.channels} mse=${audioOk}`);
    return {
      info,
      videoStream,
      audioStream,
      canPlay: videoOk && audioOk,
      videoCodec: videoStream?.codec_name || '',
      audioCodec: audioStream?.codec_name || ''
    };
  } catch (e) {
    console.error('[web-demuxer] probe failed:', e);
    throw e;
  } finally {
    if (demuxer) demuxer.destroy();
  }
}

/**
 * WebDemuxerPlayer — 一个 video 元素绑定一个实例。
 */
export class WebDemuxerPlayer {
  constructor() {
    this.demuxer = null;
    this.videoEl = null;
    this.mediaSource = null;
    this.videoBuffer = null;
    this.audioBuffer = null;
    this.info = null;
    this.videoStream = null;
    this.audioStream = null;
    this.sequence = 0;
    this.readerVideo = null;
    this.readerAudio = null;
    this.onError = null;  // (source) => void, source: 'video'|'audio'|'attach'
    this._failed = false;
    this._appending = false;
    this._videoQueue = [];
    this._audioQueue = [];
    this._destroyed = false;
    this._seeking = false;
    this._onSourceOpen = null;
    this.loop = false;          // 循环播放：流读完后自动从 0 重新 demux
    this._videoDone = false;
    this._audioDone = false;
    this._basePts = null;       // 视频起始 pts，用于音视频时间轴对齐
  }

  /**
   * 绑定 video 元素并准备播放。
   * 先调用 probeFile 确认可播放后再调用此方法。
   */
  async attach(videoEl, path, videoStream, audioStream, info) {
    this.videoEl = videoEl;
    this.videoStream = videoStream;
    // 音频流参数不完整（extradata 缺失或 sample_rate 为 0）时，不添加音频轨道，
    // 否则 init segment 会导致 MediaSource 出错，连带视频 SourceBuffer 被移除
    const audioValid = audioStream && audioStream.extradata && audioStream.extradata.length > 0
      && audioStream.sample_rate && audioStream.sample_rate > 0
      && audioStream.channels && audioStream.channels > 0;
    this.audioStream = audioValid ? audioStream : null;
    this.info = info;

    // 检测视频 extradata 是否有效。h264 的 extradata 必须是 avcC 格式。
    // 如果为空或 Annex B 格式，需要从视频流的第一个 SPS/PPS 构建，延迟到 _pumpVideo 处理。
    const isH264 = videoStream?.codec_name?.toLowerCase() === 'h264';
    const extradata = videoStream?.extradata;
    const edIsAvcc = extradata && extradata.length > 0 && extradata[0] === 1;
    this._videoInitReady = !isH264 || edIsAvcc;
    this._videoInitAppended = false;

    // 1. 创建 demuxer 并加载
    this.demuxer = new WebDemuxer({ wasmFilePath: WASM_PATH });
    const url = await fileToHttpUrl(path);
    await this.demuxer.load(url);

    // 2. 构建 init segment（仅包含有效的轨道）
    const initSeg = this._videoInitReady ? buildInitSegment(videoStream, this.audioStream) : null;

    // 3. 创建 MediaSource（先监听 sourceopen 再设 src，避免事件丢失）
    this.mediaSource = new MediaSource();
    await new Promise((resolve, reject) => {
      this._onSourceOpen = () => {
        try {
          // 4. 添加 SourceBuffer
          if (videoStream) {
            const vCodec = codecString(videoStream);
            this.videoBuffer = this.mediaSource.addSourceBuffer(`video/mp4; codecs="${vCodec}"`);
            if (this._videoInitReady && initSeg) {
              this.videoBuffer.appendBuffer(initSeg);
              this._videoInitAppended = true;
            }
          }
          if (this.audioStream) {
            const aCodec = codecString(this.audioStream);
            this.audioBuffer = this.mediaSource.addSourceBuffer(`audio/mp4; codecs="${aCodec}"`);
            if (initSeg) this.audioBuffer.appendBuffer(initSeg);
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      this.mediaSource.addEventListener('sourceopen', this._onSourceOpen, { once: true });
      videoEl.src = URL.createObjectURL(this.mediaSource);
    });

    // 5. 开始流式读取
    this._startStreaming();
  }

  /** 启动从 demuxer 读取并 append 的循环 */
  _startStreaming() {
    this._videoDone = false;
    this._audioDone = false;
    if (this.videoStream) {
      this.readerVideo = this.demuxer.readMediaPacket('video').getReader();
      this._pumpVideo();
    } else {
      this._videoDone = true;
    }
    if (this.audioStream) {
      this.readerAudio = this.demuxer.readMediaPacket('audio').getReader();
      this._pumpAudio();
    } else {
      this._audioDone = true;
    }
  }

  /** 视频包读取循环：按 GOP 累积，关键帧到来时 flush 为一个 media segment */
  async _pumpVideo() {
    let gop = [];
    let prebuffer = []; // 遇到 IDR 前的 SPS/PPS 等前置数据
    let basePts = null;
    const isH264 = this.videoStream?.codec_name?.toLowerCase() === 'h264';
    while (!this._destroyed && this.readerVideo) {
      try {
        const { done, value } = await this.readerVideo.read();
        if (done) break;
        const pkt = value;
        // h264 数据可能是 Annex B 格式（TS 等容器），需转为 AVCC 才能写入 fMP4
        const pktData = isH264 ? annexBToAvcc(pkt.data) : pkt.data;
        const nals = isH264 ? analyzeH264Nals(pkt.data) : { hasIdr: false, hasSps: false, hasPps: false };
        const pktIsKey = pkt.keyframe === 1 || pkt.keyframe === true || nals.hasIdr;

        if (basePts === null) {
          // 还没开始播放：跳过无关包，收集 SPS/PPS，遇到 IDR 正式开始
          if (!nals.hasSps && !nals.hasPps && !nals.hasIdr && !pktIsKey) continue;
          // SPS 或 PPS 包（无 IDR）→ 加入预缓冲，用于构建 avcC
          if ((nals.hasSps || nals.hasPps) && !nals.hasIdr) {
            prebuffer.push({ ts: pkt.timestamp, dur: pkt.duration, raw: pkt.data, avcc: pktData });
            continue;
          }
          // 遇到 IDR（或 web-demuxer 标记的关键帧）：
          // 1. 如尚未追加 init segment，从预缓冲的 SPS/PPS 构建 avcC 并追加
          if (!this._videoInitAppended && isH264) {
            const merged = new Uint8Array(prebuffer.reduce((s, p) => s + p.raw.length, 0));
            let off = 0;
            for (const p of prebuffer) { merged.set(new Uint8Array(p.raw), off); off += p.raw.length; }
            const avcC = buildAvcCFromAnnexB(merged);
            if (avcC && this.videoStream) {
              this.videoStream.extradata = avcC;
              const initSeg = buildInitSegment(this.videoStream, this.audioStream);
              if (this.videoBuffer) {
                await this._appendBuffer(this.videoBuffer, initSeg);
                this._videoInitAppended = true;
              }
            }
          }
          // 2. 把预缓冲和当前包作为第一个 GOP
          if (prebuffer.length > 0) {
            for (const p of prebuffer) {
              gop.push({ pts: p.ts, duration: p.dur, data: p.avcc, keyframe: false });
            }
            basePts = prebuffer[0].ts;
          } else {
            basePts = pkt.timestamp;
          }
          gop.push({ pts: pkt.timestamp - basePts, duration: pkt.duration, data: pktData, keyframe: true });
          prebuffer = [];
          this._basePts = basePts; // 共享给音频线程做时间轴对齐
          continue;
        }

        // 正常播放阶段：按关键帧分割 GOP
        const sample = {
          pts: pkt.timestamp - basePts,
          duration: pkt.duration,
          data: pktData,
          keyframe: pktIsKey
        };
        if (sample.keyframe && gop.length > 0) {
          await this._flushVideo(gop);
          gop = [];
        }
        gop.push(sample);
      } catch (e) {
        if (!this._destroyed) {
          console.warn('web-demuxer video read error:', e, e?.message, e?.type, e?.detail);
          this._failed = true;
          this.onError?.('video');
        }
        break;
      }
    }
    if (gop.length > 0) {
      await this._flushVideo(gop).catch(() => {});
    }
    this._videoDone = true;
    this._checkLoopRestart();
  }

  async _flushVideo(gop) {
    if (!this.videoBuffer || this._destroyed) return;
    const seg = buildMediaSegment(gop, null, this.sequence++, VIDEO_TIMESCALE);
    await this._appendBuffer(this.videoBuffer, seg);
  }

  async _pumpAudio() {
    // 音频按固定包数（如 10 个 AAC frame）封装一个 segment
    const CHUNK = 10;
    let batch = [];
    const timescale = 1_000_000;
    // 等待视频的 basePts 确定，保证音视频时间轴对齐
    while (!this._destroyed && this._basePts === null) {
      await new Promise(r => setTimeout(r, 20));
    }
    const basePts = this._basePts ?? 0;
    while (!this._destroyed && this.readerAudio) {
      try {
        const { done, value } = await this.readerAudio.read();
        if (done) break;
        const pkt = value;
        batch.push({
          pts: pkt.timestamp - basePts,
          duration: pkt.duration,
          data: pkt.data,
          keyframe: true
        });
        if (batch.length >= CHUNK) {
          await this._flushAudio(batch, timescale);
          batch = [];
        }
      } catch (e) {
        if (!this._destroyed) {
          console.warn('web-demuxer audio read error, skip audio:', e);
          this.readerAudio = null;
        }
        break;
      }
    }
    if (batch.length > 0) {
      await this._flushAudio(batch, timescale).catch(() => {});
    }
    this._audioDone = true;
    this._checkLoopRestart();
  }

  /** 音视频流都读完且 loop 开启时，重新从 0 开始 demux */
  _checkLoopRestart() {
    if (this._destroyed || !this.loop) return;
    if (!(this._videoDone && this._audioDone)) return;
    if (this._seeking) return;
    // 延迟一帧，避免与正在进行的 append 冲突
    setTimeout(() => {
      if (this._destroyed || !this.loop) return;
      this.seek(0).catch(() => {});
    }, 50);
  }

  async _flushAudio(batch, timescale) {
    if (!this.audioBuffer || this._destroyed) return;
    const seg = buildMediaSegment(null, batch, this.sequence++, VIDEO_TIMESCALE, timescale);
    await this._appendBuffer(this.audioBuffer, seg);
  }

  /** 带背压的 append：buffer 正在 updating 时排队等待 */
  _appendBuffer(buffer, data) {
    return new Promise((resolve, reject) => {
      const doAppend = () => {
        if (this._destroyed) { resolve(); return; }
        if (buffer.updating) {
          buffer.addEventListener('updateend', doAppend, { once: true });
          return;
        }
        try {
          buffer.appendBuffer(data);
          buffer.addEventListener('updateend', () => resolve(), { once: true });
          buffer.addEventListener('error', (e) => reject(e), { once: true });
        } catch (e) {
          reject(e);
        }
      };
      doAppend();
    });
  }

  /**
   * Seek 到指定时间。
   * 策略：移除所有 SourceBuffer 的缓冲区间，重新从目标时间读取。
   */
  async seek(time) {
    if (this._destroyed || !this.demuxer) return;
    this._seeking = true;

    // 停止当前读取
    if (this.readerVideo) { try { await this.readerVideo.cancel(); } catch {} this.readerVideo = null; }
    if (this.readerAudio) { try { await this.readerAudio.cancel(); } catch {} this.readerAudio = null; }

    // 清空缓冲
    const clearBuf = (buf) => new Promise((resolve) => {
      if (!buf) { resolve(); return; }
      const doClear = () => {
        if (buf.updating) { buf.addEventListener('updateend', doClear, { once: true }); return; }
        try {
          for (let i = 0; i < buf.buffered.length; i++) {
            buf.remove(buf.buffered.start(i), buf.buffered.end(i));
          }
          buf.addEventListener('updateend', () => resolve(), { once: true });
        } catch { resolve(); }
      };
      doClear();
    });

    await Promise.all([clearBuf(this.videoBuffer), clearBuf(this.audioBuffer)]);

    // 重新从目标时间读取
    this.sequence = 0;
    this._basePts = null;
    this._videoDone = !this.videoStream;
    this._audioDone = !this.audioStream;
    if (this.videoStream) {
      this.readerVideo = this.demuxer.readMediaPacket('video', time).getReader();
      this._pumpVideo();
    }
    if (this.audioStream) {
      this.readerAudio = this.demuxer.readMediaPacket('audio', time).getReader();
      this._pumpAudio();
    }
    this._seeking = false;
  }

  /** 销毁并释放所有资源 */
  destroy() {
    this._destroyed = true;
    if (this.readerVideo) { try { this.readerVideo.cancel(); } catch {} this.readerVideo = null; }
    if (this.readerAudio) { try { this.readerAudio.cancel(); } catch {} this.readerAudio = null; }
    if (this.videoEl && this.videoEl.src) {
      URL.revokeObjectURL(this.videoEl.src);
      this.videoEl.removeAttribute('src');
    }
    if (this.demuxer) { this.demuxer.destroy(); this.demuxer = null; }
    this.mediaSource = null;
    this.videoBuffer = null;
    this.audioBuffer = null;
  }
}

/** 全局探测缓存：path -> probe 结果（Promise），避免重复加载文件 */
const probeCache = new Map();
/** 同步可读的探测结果缓存：path -> {canPlay, videoCodec, audioCodec} */
export const probeResultSync = new Map();

export async function probeCached(path) {
  console.log('[web-demuxer] probeCached called:', path, 'cached=', probeCache.has(path));
  if (probeCache.has(path)) return probeCache.get(path);
  const p = probeFile(path).catch(e => ({ canPlay: false, error: String(e) }));
  probeCache.set(path, p);
  p.then(r => {
    probeResultSync.set(path, {
      canPlay: r.canPlay,
      videoCodec: r.videoCodec || '',
      audioCodec: r.audioCodec || ''
    });
    if (!r.canPlay) setTimeout(() => { probeCache.delete(path); probeResultSync.delete(path); }, 30000);
  });
  return p;
}
