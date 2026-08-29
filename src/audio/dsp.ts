/** Web Audio 合成基元。所有声音都是程序化生成，不加载任何音频文件。 */

export function mtof(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

let noiseBuf: AudioBuffer | null = null;

export function noise(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

/** 简易混响：噪声衰减当脉冲响应，够用且零资源 */
export function makeReverb(ctx: BaseAudioContext, seconds = 2.0, decay = 2.6): ConvolverNode {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  return conv;
}

/** FM 电钢：city pop 的灵魂音色 */
export function fmKeys(
  ctx: BaseAudioContext,
  dest: AudioNode,
  freq: number,
  time: number,
  dur: number,
  gain: number,
  ratio = 2,
  index = 1.4,
): void {
  const car = ctx.createOscillator();
  car.type = 'sine';
  car.frequency.value = freq;

  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = freq * ratio;

  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(freq * index, time);
  modGain.gain.exponentialRampToValueAtTime(freq * 0.05, time + dur * 0.6);
  mod.connect(modGain).connect(car.frequency);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, time);
  env.gain.linearRampToValueAtTime(gain, time + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  car.connect(env).connect(dest);
  car.start(time);
  mod.start(time);
  car.stop(time + dur + 0.05);
  mod.stop(time + dur + 0.05);
}

export function bass(
  ctx: BaseAudioContext,
  dest: AudioNode,
  freq: number,
  time: number,
  dur: number,
  gain: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, time);
  lp.frequency.exponentialRampToValueAtTime(220, time + dur);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, time);
  env.gain.linearRampToValueAtTime(gain, time + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(lp).connect(env).connect(dest);
  osc.start(time);
  osc.stop(time + dur + 0.05);
}

export function kick(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 0.9): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(45, time + 0.11);

  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + 0.24);

  osc.connect(env).connect(dest);
  osc.start(time);
  osc.stop(time + 0.26);
}

export function snare(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 0.4): void {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.8;

  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);

  src.connect(bp).connect(env).connect(dest);
  src.start(time);
  src.stop(time + 0.18);
}

export function hihat(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 0.14, bright = 1): void {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000 * bright;

  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);

  src.connect(hp).connect(env).connect(dest);
  src.start(time);
  src.stop(time + 0.06);
}

/** 铃音：ambient 与升级音效都用它 */
export function bell(
  ctx: BaseAudioContext,
  dest: AudioNode,
  freq: number,
  time: number,
  dur: number,
  gain: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;

  const harm = ctx.createOscillator();
  harm.type = 'sine';
  harm.frequency.value = freq * 2.76; // 钟声的非谐泛音

  const hg = ctx.createGain();
  hg.gain.value = 0.18;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, time);
  env.gain.linearRampToValueAtTime(gain, time + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(env);
  harm.connect(hg).connect(env);
  env.connect(dest);
  osc.start(time);
  harm.start(time);
  osc.stop(time + dur + 0.05);
  harm.stop(time + dur + 0.05);
}
