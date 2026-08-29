import { bass, bell, fmKeys, hihat, kick, makeReverb, mtof, noise, snare } from './dsp';

export type MusicChannel = 'citypop' | 'lofi' | 'ambient';

type ChordName = 'Imaj7' | 'ii7' | 'iii7' | 'IVmaj7' | 'V7' | 'vi7';

/** C 大调七和弦，city pop 的味道全在这些七音里 */
const CHORDS: Record<ChordName, number[]> = {
  Imaj7: [60, 64, 67, 71],
  ii7: [62, 65, 69, 72],
  iii7: [64, 67, 71, 74],
  IVmaj7: [65, 69, 72, 76],
  V7: [67, 71, 74, 77],
  vi7: [69, 72, 76, 79],
};

const PROGRESSIONS: ChordName[][] = [
  ['IVmaj7', 'V7', 'iii7', 'vi7'], // 王道进行
  ['ii7', 'V7', 'Imaj7', 'Imaj7'],
  ['Imaj7', 'vi7', 'ii7', 'V7'],
  ['iii7', 'vi7', 'ii7', 'V7'],
  ['Imaj7', 'IVmaj7', 'iii7', 'vi7'],
];

const KICK = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
const SNARE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
const HAT = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1];
const PENTA = [0, 2, 4, 7, 9];

const BPM: Record<MusicChannel, number> = { citypop: 104, lofi: 76, ambient: 58 };

/**
 * 程序化 BGM。用 lookahead 调度器提前 120ms 排音符，
 * 避免 setInterval 抖动导致节奏不稳。
 */
export class MusicEngine {
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private prog = 0;
  private channel: MusicChannel = 'citypop';
  private intensity = 0;
  private ambientSrc: AudioBufferSourceNode | null = null;

  constructor(
    private ctx: AudioContext,
    private out: GainNode,
  ) {}

  get current(): MusicChannel {
    return this.channel;
  }

  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  start(channel: MusicChannel): void {
    this.stop();
    this.channel = channel;
    this.step = 0;
    this.bar = 0;
    this.prog = Math.floor(Math.random() * PROGRESSIONS.length);
    this.nextTime = this.ctx.currentTime + 0.08;

    if (channel === 'ambient') this.startWind();

    this.timer = window.setInterval(this.tick, 25);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopWind();
  }

  private get stepDur(): number {
    return 60 / BPM[this.channel] / 4;
  }

  private tick = (): void => {
    const ahead = this.ctx.currentTime + 0.12;
    while (this.nextTime < ahead) {
      this.schedule(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step += 1;
      if (this.step >= 16) {
        this.step = 0;
        this.bar += 1;
        if (this.bar >= 4) {
          this.bar = 0;
          // 每轮有概率换一套和弦进行，久听不腻
          if (Math.random() < 0.45) {
            this.prog = Math.floor(Math.random() * PROGRESSIONS.length);
          }
        }
      }
    }
  };

  private chordName(): ChordName {
    return PROGRESSIONS[this.prog][this.bar];
  }

  private schedule(step: number, time: number): void {
    if (this.channel === 'ambient') return this.scheduleAmbient(step, time);
    if (this.channel === 'lofi') return this.scheduleLofi(step, time);
    this.scheduleCityPop(step, time);
  }

  private scheduleCityPop(step: number, time: number): void {
    const chord = CHORDS[this.chordName()];
    const bus = this.out;

    if (KICK[step]) kick(this.ctx, bus, time, 0.85);
    if (SNARE[step]) snare(this.ctx, bus, time, 0.34);
    // 热潮时加密 hihat，气氛立刻起来
    if (HAT[step] || (this.intensity > 0 && step % 2 === 1)) {
      hihat(this.ctx, bus, time, HAT[step] ? 0.1 : 0.06 + this.intensity * 0.06);
    }

    // 电钢：正拍 + 切分，city pop 的招牌律动
    if (step === 0 || step === 6 || step === 10) {
      const vel = step === 0 ? 0.09 : 0.055;
      chord.forEach((n, i) => {
        fmKeys(this.ctx, bus, mtof(n + (i === 0 ? -12 : 0)), time + i * 0.006, 0.85, vel);
      });
    }

    // 贝斯：根音 + 五度
    const root = chord[0] - 24;
    if (step === 0 || step === 6 || step === 11) {
      const note = step === 6 ? root + 7 : root;
      bass(this.ctx, bus, mtof(note), time, step === 0 ? 0.42 : 0.3, 0.16);
    }

    // 偶尔来一句琶音点缀
    if (this.intensity > 0 && step === 12 && Math.random() < 0.5) {
      const arp = [chord[1], chord[2], chord[3], chord[2] + 12];
      arp.forEach((n, i) => {
        fmKeys(this.ctx, bus, mtof(n + 12), time + i * 0.07, 0.3, 0.05, 3, 0.8);
      });
    }
  }

  private scheduleLofi(step: number, time: number): void {
    const chord = CHORDS[this.chordName()];
    const bus = this.out;

    if (step === 0 || step === 10) kick(this.ctx, bus, time, 0.6);
    if (step === 4 || step === 12) snare(this.ctx, bus, time, 0.22);
    if (step % 2 === 0) hihat(this.ctx, bus, time, 0.05, 0.6);

    if (step === 0) {
      chord.forEach((n, i) => {
        fmKeys(this.ctx, bus, mtof(n - 12), time + i * 0.02, 1.6, 0.07, 1.5, 0.9);
      });
    }
    if (step === 0 || step === 8) {
      bass(this.ctx, bus, mtof(chord[0] - 24), time, 0.7, 0.15);
    }
    // 稀疏的电钢点缀
    if (step === 6 && Math.random() < 0.6) {
      const n = chord[Math.floor(Math.random() * chord.length)];
      fmKeys(this.ctx, bus, mtof(n + 12), time, 0.6, 0.04, 2, 1.1);
    }
  }

  private scheduleAmbient(step: number, time: number): void {
    // 风声是常驻的，这里只随机撒铃音
    if (step !== 0 && step !== 8) return;
    if (Math.random() > 0.55) return;
    const base = 72 + PENTA[Math.floor(Math.random() * PENTA.length)];
    bell(this.ctx, this.out, mtof(base), time, 3.2, 0.05);
    if (Math.random() < 0.4) {
      bell(this.ctx, this.out, mtof(base + 7), time + 0.28, 2.4, 0.032);
    }
  }

  private startWind(): void {
    const src = this.ctx.createBufferSource();
    src.buffer = noise(this.ctx);
    src.loop = true;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;

    const g = this.ctx.createGain();
    g.gain.value = 0.035;

    // 缓慢起伏，像远处的风
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.022;
    lfo.connect(lfoGain).connect(g.gain);

    src.connect(lp).connect(g).connect(this.out);
    src.start();
    lfo.start();
    this.ambientSrc = src;
  }

  private stopWind(): void {
    if (this.ambientSrc) {
      try {
        this.ambientSrc.stop();
      } catch {
        // 已经停了就没关系
      }
      this.ambientSrc = null;
    }
  }
}

/**
 * 音乐总线：干声 + 混响湿声并行到目标节点。
 * 目标由调用方传入，避免外部再 disconnect 重连时把混响分支弄断。
 */
export function createMusicBus(ctx: AudioContext, dest: AudioNode): GainNode {
  const bus = ctx.createGain();
  bus.gain.value = 0.55;

  const reverb = makeReverb(ctx, 2.0, 2.6);
  const wet = ctx.createGain();
  wet.gain.value = 0.28;

  bus.connect(reverb).connect(wet).connect(dest);
  bus.connect(dest);
  return bus;
}
