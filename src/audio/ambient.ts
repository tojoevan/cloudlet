import { noise } from './dsp';

/**
 * 环境音层：鸟鸣 / 虫鸣 / 风 / 雨。
 *
 * 为什么单独一层而不是塞进 BGM：音乐是"有旋律的"，而解压感很大程度来自
 * **无旋律的环境声**——它让画面像"一个真实的地方"，而不是"一个配了 BGM 的界面"。
 * 参考同类休闲/陪伴作品：白天鸟叫、夜里虫鸣，是最省成本也最有效的昼夜线索。
 *
 * 全部程序化合成，不加载任何音频文件。
 */
export class AmbientEngine {
  private birdTimer = 0;
  private cricketTimer = 0;
  private wind: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private rain: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private day = true;
  private rainLevel = 0;
  /** 季节微调：春天鸟多、夏天虫多、秋冬风更响 */
  private birdMul = 1;
  private cricketMul = 1;
  private windMul = 1;
  private running = false;

  constructor(
    private ctx: AudioContext,
    private out: GainNode,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startWind();
    this.startRain();
  }

  stop(): void {
    this.running = false;
    this.wind?.src.stop();
    this.rain?.src.stop();
    this.wind = null;
    this.rain = null;
  }

  /** 季节微调环境音：鸟/虫/风的密度与强度 */
  setSeason(season: string): void {
    switch (season) {
      case 'spring':
        this.birdMul = 1.6; this.cricketMul = 0.6; this.windMul = 0.9;
        break;
      case 'summer':
        this.birdMul = 1.1; this.cricketMul = 1.8; this.windMul = 0.8;
        break;
      case 'autumn':
        this.birdMul = 0.9; this.cricketMul = 1.0; this.windMul = 1.3;
        break;
      case 'winter':
        this.birdMul = 0.35; this.cricketMul = 0.15; this.windMul = 1.6;
        break;
      default:
        this.birdMul = 1; this.cricketMul = 1; this.windMul = 1;
    }
  }

  /**
   * 节日对环境的微调：夏日祭更热闹（虫鸣↑），丰收节风更足，
   * 雪灯节安静下来，只留一点风。
   */
  setFestival(fest: string | null): void {
    switch (fest) {
      case 'sakura':
        this.birdMul = 1.5; this.cricketMul = 0.8; this.windMul = 0.9;
        break;
      case 'nightmarket':
        this.cricketMul = 2.0; this.windMul = 0.7;
        break;
      case 'harvest':
        this.windMul = 1.45; this.birdMul = 1.1;
        break;
      case 'snowlight':
        this.birdMul = 0.25; this.cricketMul = 0.2; this.windMul = 1.3;
        break;
      default:
        break;
    }
  }

  /** 白天/夜晚切换：鸟鸣与虫鸣此消彼长 */
  setDay(day: boolean): void {
    this.day = day;
  }

  /** 0~1：雨声强度 */
  setRain(level: number): void {
    this.rainLevel = Math.max(0, Math.min(1, level));
    if (this.rain) {
      const t = this.ctx.currentTime;
      this.rain.gain.gain.cancelScheduledValues(t);
      this.rain.gain.gain.linearRampToValueAtTime(this.rainLevel * 0.16, t + 1.2);
    }
  }

  /** 由主循环按 dt 调用（秒） */
  update(dt: number): void {
    if (!this.running) return;

    // 风：缓慢起伏，像有呼吸
    if (this.wind) {
      const t = this.ctx.currentTime;
      const lvl = (0.035 + Math.sin(t * 0.13) * 0.018 + Math.sin(t * 0.37) * 0.008) * this.windMul;
      this.wind.gain.gain.setTargetAtTime(Math.max(0.01, lvl), t, 0.8);
    }

    // 鸟鸣：白天随机，成串的短促滑音
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = ((this.day ? 2.6 : 7.5) + Math.random() * (this.day ? 4.5 : 6)) / this.birdMul;
      if (this.day && Math.random() > 0.15) this.chirp();
    }

    // 虫鸣：夜里随机，高频短脉冲
    this.cricketTimer -= dt;
    if (this.cricketTimer <= 0) {
      this.cricketTimer = ((this.day ? 6 : 1.6) + Math.random() * (this.day ? 6 : 2.6)) / this.cricketMul;
      if (!this.day) this.cricket();
    }
  }

  private startWind(): void {
    const src = this.ctx.createBufferSource();
    src.buffer = noise(this.ctx);
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 480;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.03;
    src.connect(filter).connect(gain).connect(this.out);
    src.start();
    this.wind = { src, gain, filter };
  }

  private startRain(): void {
    const src = this.ctx.createBufferSource();
    src.buffer = noise(this.ctx);
    src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(hp).connect(gain).connect(this.out);
    src.start();
    this.rain = { src, gain };
  }

  /** 一串鸟叫：3~5 个快速上滑音 */
  private chirp(): void {
    const ctx = this.ctx;
    const dest = this.out;
    const base = 1900 + Math.random() * 1400;
    const notes = 2 + Math.floor(Math.random() * 4);
    const t0 = ctx.currentTime + 0.02;
    for (let i = 0; i < notes; i++) {
      const t = t0 + i * (0.075 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const f0 = base * (0.85 + Math.random() * 0.3);
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * (1.25 + Math.random() * 0.35), t + 0.06);
      const vol = 0.028 + Math.random() * 0.022;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      osc.connect(gain).connect(dest);
      osc.start(t);
      osc.stop(t + 0.14);
    }
  }

  /** 虫鸣：两三个高频短脉冲，间隔很近，像蟋蟀 */
  private cricket(): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const base = 4300 + Math.random() * 700;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.085;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(base, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.012, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      osc.connect(gain).connect(this.out);
      osc.start(t);
      osc.stop(t + 0.06);
    }
  }
}
