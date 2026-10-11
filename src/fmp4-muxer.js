// ═══════════════════════════════════════════════════════
// fmp4-muxer.js — 轻量 fragmented MP4 封装器
//
// 将 web-demuxer 解出的编码包（h264/h265/aac/vp9/opus）封装为
// fMP4 的 init segment + media segment，喂给 MediaSource。
//
// 设计目标：
//   - 零依赖、纯 JS，不引入 mp4box.js（~200KB）
//   - 只生成 MSE 必需的 box，省略可选 box
//   - 每个 GOP（关键帧起）封装为一个 media segment
// ═══════════════════════════════════════════════════════

// ─── box 工具 ────────────────────────────────────────
const enc = new TextEncoder();

/** 写一个 box：[size(4)][type(4)][payload] */
function box(type, payload) {
  const size = 8 + payload.byteLength;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, size);
  buf.set(enc.encode(type), 4);
  buf.set(payload, 8);
  return buf;
}

/** 拼接多个 box */
function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.byteLength; }
  return out;
}

/** 写入 32 位无符号整数（大端）到 ArrayBuffer */
function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
function u16(v) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 0xffff);
  return b;
}
function u8(v) {
  return new Uint8Array([v & 0xff]);
}

// ─── 编码参数 → MSE codec 字符串 ───────────────────
/**
 * 根据 web-demuxer 的 stream 信息生成 MSE codec 字符串。
 * 用于 MediaSource.isTypeSupported 检测和 SourceBuffer 创建。
 */
export function codecString(stream) {
  const name = stream.codec_name?.toLowerCase();
  switch (name) {
    case 'h264':
    case 'avc':
    case 'avc1': {
      // avc1.<profile><constraint><level>，如 avc1.64001e
      const cfg = parseAvcC(stream.extradata);
      if (cfg) return `avc1.${cfg.profile}${cfg.constraint}${cfg.level}`;
      return 'avc1.42E01E'; // baseline 3.0 兜底
    }
    case 'hevc':
    case 'h265': {
      const cfg = parseHvcC(stream.extradata);
      if (cfg) return `hvc1.${cfg.profile}.${cfg.constraint}.${cfg.level}`;
      return 'hvc1.1.6.L93.B0';
    }
    case 'vp9':
    case 'vp09': {
      // vp09.<profile>.<level>.<bitDepth>.<chroma>
      const profile = stream.profile === 'Profile 1' || stream.profile === '1' ? '01' : '00';
      const level = stream.level > 0 ? String(stream.level).padStart(2, '0') : '10';
      return `vp09.${profile}.${level}.10.01.01.01.00`;
    }
    case 'av1':
    case 'av01':
      return `av01.0.04M.08`;
    case 'aac':
    case 'mp4a': {
      // mp4a.40.<objectTypeIndication>，aac-lc 是 2
      return 'mp4a.40.2';
    }
    case 'opus':
      return 'opus';
    case 'flac':
      return 'fLaC';
    case 'mp3':
    case 'mp3float':
      return 'mp3';
    default:
      return name || '';
  }
}

/** 从 avcC (h264 extradata) 解析 profile/constraint/level */
function parseAvcC(data) {
  if (!data || data.byteLength < 7) return null;
  // avcC 首字节 configurationVersion 必须为 1；否则可能是 Annex B 等非 avcC 数据
  if (data[0] !== 1) return null;
  const profile = data[1].toString(16).padStart(2, '0');
  const constraint = data[2].toString(16).padStart(2, '0');
  const level = data[3].toString(16).padStart(2, '0');
  return { profile, constraint, level };
}

/** 从 hvcC (h265 extradata) 解析参数 */
function parseHvcC(data) {
  if (!data || data.byteLength < 23) return null;
  // hvcC 首字节 configurationVersion 必须为 1
  if (data[0] !== 1) return null;
  const profileSpace = (data[1] >> 6) & 0x3;
  const tierFlag = (data[1] >> 5) & 0x1;
  const profileIdc = data[1] & 0x1f;
  const levelIdc = data[12];
  const profile = String(profileSpace * 32 + profileIdc);
  const constraint = [...data.slice(5, 9)].map(b => b.toString(16).padStart(2, '0')).join('.');
  const level = `L${levelIdc}${tierFlag ? '.B0' : '.00'}`;
  return { profile, constraint, level };
}

// ─── Init Segment 构建 ──────────────────────────────
const VIDEO_TIMESCALE = 1_000_000; // web-demuxer 返回的 timestamp 单位是微秒

/**
 * 构建 fMP4 init segment。
 * @param {Object} videoStream - web-demuxer 的视频流信息（含 extradata）
 * @param {Object} [audioStream] - 音频流信息
 * @returns {Uint8Array} init segment 字节
 */
export function buildInitSegment(videoStream, audioStream) {
  const ftyp = buildFtyp();
  const moov = buildMoov(videoStream, audioStream);
  return concat(ftyp, moov);
}

function buildFtyp() {
  // ftyp: major_brand(4) + minor_version(4) + compatible_brands(4n)
  const payload = concat(
    enc.encode('iso6'), // major brand
    u32(0),             // minor version
    enc.encode('iso6'), enc.encode('iso2'), enc.encode('mp41'), enc.encode('dash') // compatible
  );
  return box('ftyp', payload);
}

function buildMoov(videoStream, audioStream) {
  const mvhd = buildMvhd();
  const trakVideo = buildTrakVideo(videoStream);
  const traks = [trakVideo];
  if (audioStream) traks.push(buildTrakAudio(audioStream));
  // mvex 告诉播放器这是 fragmented mp4
  const mvex = box('mvex', concat(
    box('trex', concat(u32(1), u32(1), u32(0), u32(0), u32(0))), // track id 1
    audioStream ? box('trex', concat(u32(2), u32(2), u32(0), u32(0), u32(0))) : new Uint8Array(0)
  ));
  return box('moov', concat(mvhd, ...traks, mvex));
}

function buildMvhd() {
  // mvhd: version(1)+flags(3) + creation_time(4) + modification_time(4)
  //       + timescale(4) + duration(4) + rate(4) + volume(2) + reserved(10)
  //       + matrix(36) + pre_defined(24) + next_track_id(4)
  const payload = concat(
    u32(0),                       // version + flags
    u32(0), u32(0),               // creation/modification time
    u32(VIDEO_TIMESCALE),         // timescale
    u32(0),                       // duration (0 for fragmented)
    u32(0x00010000),              // rate 1.0
    u16(0x0100),                  // volume 1.0
    new Uint8Array(10),           // reserved
    // matrix (9 * 4 bytes = 36): identity
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    new Uint8Array(24),           // pre_defined
    u32(3)                        // next track id
  );
  return box('mvhd', payload);
}

function buildTrakHeader(trackId, width, height, duration) {
  // tkhd: version(1)+flags(3) + creation(4) + modification(4) + track_id(4)
  //       + reserved(4) + duration(4) + reserved(8) + layer(2) + alt_group(2)
  //       + volume(2) + reserved(2) + matrix(36) + width(4) + height(4)
  const payload = concat(
    u32(0x00000003), // flags: track_enabled | track_in_movie
    u32(0), u32(0),
    u32(trackId),
    u32(0),          // reserved
    u32(duration),
    new Uint8Array(8),
    u16(0), u16(0),  // layer, alt_group
    u16(width ? 0x0100 : 0), // volume (video=0, audio=0x0100)
    u16(0),          // reserved
    // matrix identity
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32(width << 16),   // width (16.16 fixed point)
    u32(height << 16)   // height
  );
  return box('tkhd', payload);
}

function buildMdiaHeader(timescale, duration) {
  // mdhd: version+flags + creation + modification + timescale + duration + language + pre_defined
  return box('mdhd', concat(
    u32(0), u32(0), u32(0),
    u32(timescale),
    u32(duration),
    u16(0x55C4), // language 'und'
    u16(0)
  ));
}

function buildHdlr(handlerType) {
  // hdlr: version+flags + pre_defined + handler_type + reserved(12) + name
  const name = enc.encode(handlerType === 'vide' ? 'VideoHandler' : 'SoundHandler');
  return box('hdlr', concat(
    u32(0), u32(0),
    enc.encode(handlerType),
    new Uint8Array(12),
    name, u8(0) // null terminated
  ));
}

function buildDinf() {
  return box('dinf', box('dref', concat(
    u32(0), u32(1), // version+flags, entry_count
    // url entry
    box('url ', concat(u32(0x00000001))) // flags=self-contained
  )));
}

function buildStblEmpty() {
  // 空的 sample table（fragmented 模式下实际数据在 moof 中）
  return box('stbl', concat(
    box('stsd', concat(u32(0), u32(0))),    // 占位，会被替换
    box('stts', concat(u32(0), u32(0))),
    box('stsc', concat(u32(0), u32(0))),
    box('stsz', concat(u32(0), u32(0), u32(0))),
    box('stco', concat(u32(0), u32(0)))
  ));
}

// ─── 视频 trak ───────────────────────────────────────
function buildTrakVideo(stream) {
  const codec = stream.codec_name?.toLowerCase();
  const stsd = buildVideoStsd(codec, stream);
  const tkhd = buildTrakHeader(1, stream.width || 0, stream.height || 0, 0);
  const mdhd = buildMdiaHeader(VIDEO_TIMESCALE, 0);
  const hdlr = buildHdlr('vide');
  const minf = box('minf', concat(
    box('vmhd', concat(u32(0x00000001), u16(0), u16(0), u16(0), u16(0))),
    buildDinf(),
    box('stbl', concat(stsd,
      box('stts', concat(u32(0), u32(0))),
      box('stsc', concat(u32(0), u32(0))),
      box('stsz', concat(u32(0), u32(0), u32(0))),
      box('stco', concat(u32(0), u32(0)))
    ))
  ));
  return box('trak', concat(tkhd, box('mdia', concat(mdhd, hdlr, minf))));
}

function buildVideoStsd(codec, stream) {
  let sampleEntry;
  switch (codec) {
    case 'h264': case 'avc': case 'avc1':
      sampleEntry = buildAvc1Entry(stream);
      break;
    case 'hevc': case 'h265':
      sampleEntry = buildHvc1Entry(stream);
      break;
    case 'vp9': case 'vp09':
      sampleEntry = buildVp09Entry(stream);
      break;
    case 'av1': case 'av01':
      sampleEntry = buildAv01Entry(stream);
      break;
    default:
      sampleEntry = buildAvc1Entry(stream); // 兜底
  }
  return box('stsd', concat(u32(0), u32(1), sampleEntry));
}

/** Visual sample entry 公共头部：reserved(6) + data_reference_index(2) + ... */
function visualEntryHeader(width, height) {
  return concat(
    new Uint8Array(6), // reserved
    u16(1),            // data_reference_index
    u16(0), u16(0),    // pre_defined, reserved
    new Uint8Array(12),// pre_defined
    u16(width), u16(height),
    u32(0x00480000),   // horizresolution 72 dpi
    u32(0x00480000),   // vertresolution
    u32(0),            // reserved
    u16(1),            // frame_count
    new Uint8Array(32),// compressorname
    u16(0x0018),       // depth 24
    u16(0xFFFF)        // pre_defined
  );
}

function buildAvc1Entry(stream) {
  const header = visualEntryHeader(stream.width || 0, stream.height || 0);
  const avcC = stream.extradata || new Uint8Array(0);
  // avc1 box: header + avcC
  const entry = concat(header, box('avcC', avcC));
  return box('avc1', entry);
}

function buildHvc1Entry(stream) {
  const header = visualEntryHeader(stream.width || 0, stream.height || 0);
  const hvcC = stream.extradata || new Uint8Array(0);
  const entry = concat(header, box('hvcC', hvcC));
  return box('hvc1', entry);
}

function buildVp09Entry(stream) {
  const header = visualEntryHeader(stream.width || 0, stream.height || 0);
  // vpcC: 简化版，实际应该从 extradata 解析
  const vpcC = stream.extradata || buildVpcC(stream);
  const entry = concat(header, box('vpcC', vpcC));
  return box('vp09', entry);
}

function buildVpcC(stream) {
  // vpcC: version(1) + profile(1) + level(1) + bitDepth(1) + chromaSubsampling(1)
  //       + videoFullRangeFlag(1b)+colourPrimaries(7bits) ...
  const profile = stream.profile === 'Profile 1' ? 1 : 0;
  return concat(
    u8(1),                          // version
    u8(profile),                    // profile
    u8(stream.level > 0 ? stream.level : 10), // level
    u8(stream.pix_fmt === 'yuv420p10le' ? 10 : 8), // bit depth
    u8(1),                          // chroma subsampling 4:2:0
    u8(0),                          // colour primaries
    u8(0),                          // transfer characteristics
    u8(0)                           // matrix coefficients
  );
}

function buildAv01Entry(stream) {
  const header = visualEntryHeader(stream.width || 0, stream.height || 0);
  const av1C = stream.extradata || new Uint8Array([0x81, 0x04, 0x04, 0x04]);
  const entry = concat(header, box('av1C', av1C));
  return box('av01', entry);
}

// ─── 音频 trak ───────────────────────────────────────
function buildTrakAudio(stream) {
  const codec = stream.codec_name?.toLowerCase();
  const stsd = buildAudioStsd(codec, stream);
  const tkhd = buildTrakHeader(2, 0, 0, 0);
  // web-demuxer 返回的音频 timestamp 也是微秒，timescale 统一用 1e6
  const timescale = 1_000_000;
  const mdhd = buildMdiaHeader(timescale, 0);
  const hdlr = buildHdlr('soun');
  const minf = box('minf', concat(
    box('smhd', concat(u32(0), u16(0), u16(0))),
    buildDinf(),
    box('stbl', concat(stsd,
      box('stts', concat(u32(0), u32(0))),
      box('stsc', concat(u32(0), u32(0))),
      box('stsz', concat(u32(0), u32(0), u32(0))),
      box('stco', concat(u32(0), u32(0)))
    ))
  ));
  return box('trak', concat(tkhd, box('mdia', concat(mdhd, hdlr, minf))));
}

function buildAudioStsd(codec, stream) {
  let sampleEntry;
  switch (codec) {
    case 'aac': case 'mp4a':
      sampleEntry = buildMp4aEntry(stream);
      break;
    case 'opus':
      sampleEntry = buildOpusEntry(stream);
      break;
    case 'flac':
      sampleEntry = buildFlacEntry(stream);
      break;
    default:
      sampleEntry = buildMp4aEntry(stream);
  }
  return box('stsd', concat(u32(0), u32(1), sampleEntry));
}

/** Audio sample entry 公共头部 */
function audioEntryHeader(channels, sampleRate) {
  return concat(
    new Uint8Array(6), // reserved
    u16(1),            // data_reference_index
    u16(0), u16(0),    // pre_defined, reserved
    u32(0), u32(0),    // reserved
    u16(channels),
    u16(16),           // sampleSize
    u16(0), u16(0),    // pre_defined, reserved
    u32(sampleRate << 16) // sample_rate (16.16)
  );
}

function buildMp4aEntry(stream) {
  const channels = (stream.channels && stream.channels > 0) ? stream.channels : 2;
  const sampleRate = (stream.sample_rate && stream.sample_rate > 0) ? stream.sample_rate : 44100;
  const header = audioEntryHeader(channels, sampleRate);
  // esds: AudioSpecificConfig
  const asc = stream.extradata || new Uint8Array([0x12, 0x10]); // 默认 AAC-LC 44100 stereo
  const esds = buildEsds(asc);
  return box('mp4a', concat(header, esds));
}

/** 构建 esds box，包含 AudioSpecificConfig */
function buildEsds(asc) {
  // ES_Descriptor
  const esDesc = concat(
    u8(0x03), u8(0x19), // ES_DescrTag, length
    u16(0x0001),        // ES_ID
    u8(0x00),           // streamDependenceFlag, URL_Flag, OCRstreamFlag, streamPriority
    // DecoderConfigDescriptor
    u8(0x04), u8(0x11), // DecoderConfigDescrTag, length
    u8(0x40),           // objectTypeIndication (Audio ISO/IEC 14496-3)
    u8(0x15),           // streamType (audio)
    u8(0x00), u8(0x00), u8(0x00), // bufferSizeDB
    u32(0),             // maxBitrate
    u32(0),             // avgBitrate
    // DecoderSpecificInfo
    u8(0x05), u8(asc.byteLength), // DecoderSpecificInfoTag, length
    asc,
    // SLConfigDescriptor
    u8(0x06), u8(0x01), u8(0x02)  // SLConfigDescrTag, length, predefined
  );
  return box('esds', esDesc);
}

function buildOpusEntry(stream) {
  const header = audioEntryHeader(stream.channels || 2, stream.sample_rate || 48000);
  // dOps: OpusSpecificBox
  const dOps = box('dOps', concat(
    u8(stream.channels || 2),            // OutputChannelCount
    u16(312),                            // PreSkip
    u32(stream.sample_rate || 48000),    // InputSampleRate
    u16(0),                              // OutputGain
    u8(0)                                // ChannelMappingFamily
  ));
  return box('opus', concat(header, dOps));
}

function buildFlacEntry(stream) {
  const header = audioEntryHeader(stream.channels || 2, stream.sample_rate || 44100);
  const dfLa = box('dfLa', stream.extradata || new Uint8Array(0));
  return box('fLaC', concat(header, dfLa));
}

// ─── Media Segment 构建 ──────────────────────────────
/**
 * 构建一个 fMP4 media segment。
 * 关键：trun 的 data_offset = moof 总大小 + 8 (mdat header) + 前置 track 数据总大小。
 * 所以需要先算 moof 大小，再回填 trun 里的 data_offset。
 */
export function buildMediaSegment(videoSamples, audioSamples, sequence, videoTimescale = VIDEO_TIMESCALE, audioTimescale = 1_000_000) {
  const hasVideo = videoSamples && videoSamples.length > 0;
  const hasAudio = audioSamples && audioSamples.length > 0;

  // 1. 计算各 track sample 数据总大小
  const videoDataSize = hasVideo ? videoSamples.reduce((s, x) => s + x.data.byteLength, 0) : 0;
  const audioDataSize = hasAudio ? audioSamples.reduce((s, x) => s + x.data.byteLength, 0) : 0;

  // 2. 构建 traf（data_offset 占位为 0）
  const trafVideo = hasVideo ? buildTraf(1, videoSamples, videoTimescale) : new Uint8Array(0);
  const trafAudio = hasAudio ? buildTraf(2, audioSamples, audioTimescale) : new Uint8Array(0);

  // 3. 构建 moof，得到其大小
  const mfhd = box('mfhd', u32(sequence));
  let moof = box('moof', concat(mfhd, trafVideo, trafAudio));
  const moofSize = moof.byteLength;

  // 4. 计算 data_offset 并回填 trun
  // 视频 data_offset = moof 大小 + 8 (mdat header)
  // 音频 data_offset = 视频偏移 + 视频数据大小
  const videoOffset = moofSize + 8;
  const audioOffset = videoOffset + videoDataSize;

  if (hasVideo) patchTrunDataOffset(trafVideo, videoOffset);
  if (hasAudio) patchTrunDataOffset(trafAudio, audioOffset);

  // 5. 重新组装（traf 已就地修改）
  moof = box('moof', concat(mfhd, trafVideo, trafAudio));

  // 6. mdat
  const mdatData = concat(
    hasVideo ? concat(...videoSamples.map(s => s.data)) : new Uint8Array(0),
    hasAudio ? concat(...audioSamples.map(s => s.data)) : new Uint8Array(0)
  );
  const mdat = box('mdat', mdatData);

  return concat(moof, mdat);
}

/** 就地修改 traf 中 trun 的 data_offset 字段 */
function patchTrunDataOffset(traf, offset) {
  // traf 结构: traf header(8) + tfhd + tfdt + trun
  // trun 的 data_offset 在: traf[8 + tfhd + tfdt + 8(trun header) + 4(flags) + 4(count)] = 第 24 字节起的 4 字节
  // 但更稳妥的方式是扫描 trun box
  let p = 8; // 跳过 traf header
  while (p < traf.byteLength) {
    const size = new DataView(traf.buffer, traf.byteOffset + p).getUint32(0);
    const type = String.fromCharCode(...traf.slice(p + 4, p + 8));
    if (type === 'trun') {
      // trun: header(8) + version+flags(4) + sample_count(4) + data_offset(4)
      const dv = new DataView(traf.buffer, traf.byteOffset + p + 8 + 4 + 4);
      dv.setUint32(0, offset >>> 0);
      return;
    }
    p += size;
  }
}

/**
 * 构建一个 track fragment (traf)。
 */
function buildTraf(trackId, samples, timescale) {
  if (!samples || samples.length === 0) return new Uint8Array(0);

  // tfhd flags: default-base-is-moof(0x20000) | sample-description-index(0x02) | default-duration(0x08) | default-size(0x10) | default-flags(0x20)
  const tfhdFlags = 0x02003A;
  const tfhd = box('tfhd', concat(
    u32(tfhdFlags),
    u32(trackId),       // track_ID
    u32(1),             // default_sample_description_index
    u32(0),             // default_sample_duration
    u32(0),             // default_sample_size
    u32(0x01010000)     // default_sample_flags
  ));

  // tfdt: base media decode time
  const baseTime = Math.round(samples[0].pts * timescale);
  const tfdt = box('tfdt', concat(u32(0x00000001), u64(baseTime)));

  // trun flags: data-offset(0x01) | first-sample-flags(0x04) | sample-duration(0x100) | sample-size(0x400) | sample-cts(0x2000)
  const trunFlags = 0x002505;
  const sampleCount = samples.length;

  const trunParts = [
    u32(trunFlags),
    u32(sampleCount),
    u32(0), // data_offset 占位
  ];

  // first sample flags
  trunParts.push(samples[0].keyframe ? u32(0x02000000) : u32(0x01010000));

  for (const s of samples) {
    trunParts.push(u32(Math.max(1, Math.round(s.duration * timescale)))); // duration
    trunParts.push(u32(s.data.byteLength));                                // size
    trunParts.push(u32(0));                                                 // composition time offset
  }

  const trun = box('trun', concat(...trunParts));
  return box('traf', concat(tfhd, tfdt, trun));
}

function u64(v) {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, BigInt(v));
  return b;
}

export { VIDEO_TIMESCALE };
