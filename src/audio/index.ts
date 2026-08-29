import type { AudioChannel } from '../core/types';
import { bell, fmKeys, mtof } from './dsp';
import { createMusicBus, MusicEngine } from './music';

export type SfxKind = 'plant' | 'harvest' | 'coin' | 'deliver' | 'levelup' | 'fever' | 'click' | 'error';

/**
 * 音频总控。
 * 浏览器要求 AudioContext 必须在用户手势里启动，所以 unlock() 由首次点击触发。
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private music: MusicEngine | null = null;
  private radio: HTMLAudioElement | null = null;

  private channel: AudioChannel = 'citypop';
  private volume = 0.6;
  private radioUrl = '';
  private ready = false;
  private ducking = false;

  /** 在任意用户手势里调用 */
  unlock(): void {
    if (this.ready) {
      void this.ctx?.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(ctx.destination);

    const bus = createMusicBus(ctx, master);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.9;
    sfxBus.connect(master);

    this.ctx = ctx;
    this.master = master;
    this.sfxBus = sfxBus;
    this.music = new MusicEngine(ctx, bus);
    this.ready = true;

    this.applyChannel();
  }

  private applyChannel(): void {
    if (!this.ready || !this.music) return;

    this.stopRadio();
    if (this.channel === 'off') {
      this.music.stop();
      return;
    }
    if (this.channel === 'radio') {
      this.music.stop();
      this.startRadio();
      return;
    }
    this.music.start(this.channel);
  }

  private startRadio(): void {
    if (!this.radioUrl) return;
    const a = new Audio(this.radioUrl);
    a.loop = true;
    a.volume = this.volume;
    // 不设 crossOrigin：多数电台不给 CORS 头，设了反而加载失败
    void a.play().catch(() => undefined);
    this.radio = a;
  }

  private stopRadio(): void {
    if (this.radio) {
      this.radio.pause();
      this.radio.src = '';
      this.radio = null;
    }
  }

  setChannel(c: AudioChannel): void {
    this.channel = c;
    this.applyChannel();
  }

  setRadioUrl(url: string): void {
    this.radioUrl = url;
    if (this.channel === 'radio') this.applyChannel();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyGain();
    if (this.radio) this.radio.volume = this.volume;
  }

  /** 番茄钟期间压低音量，让音乐退到背景里 */
  setDucking(on: boolean): void {
    this.ducking = on;
    this.applyGain();
  }

  private applyGain(): void {
    if (this.master) this.master.gain.value = this.ducking ? this.volume * 0.55 : this.volume;
  }

  /** Fever 时把音乐推起来 */
  setIntensity(x: number): void {
    this.music?.setIntensity(x);
  }

  play(kind: SfxKind): void {
    if (!this.ready || !this.ctx || !this.sfxBus) return;
    const ctx = this.ctx;
    const bus = this.sfxBus;
    const t = ctx.currentTime + 0.01;

    switch (kind) {
      case 'plant':
        fmKeys(ctx, bus, mtof(55), t, 0.16, 0.07, 3, 0.6);
        break;
      case 'harvest':
        fmKeys(ctx, bus, mtof(72), t, 0.22, 0.09);
        fmKeys(ctx, bus, mtof(79), t + 0.06, 0.26, 0.075);
        break;
      case 'coin':
        bell(ctx, bus, mtof(88), t, 0.5, 0.09);
        bell(ctx, bus, mtof(93), t + 0.05, 0.45, 0.06);
        break;
      case 'deliver':
        [72, 76, 79, 84].forEach((n, i) => {
          fmKeys(ctx, bus, mtof(n), t + i * 0.07, 0.4, 0.08);
        });
        break;
      case 'levelup':
        [72, 76, 79, 84, 88].forEach((n, i) => {
          bell(ctx, bus, mtof(n), t + i * 0.09, 0.9, 0.08);
        });
        break;
      case 'fever':
        [67, 71, 74, 79].forEach((n, i) => {
          fmKeys(ctx, bus, mtof(n), t + i * 0.05, 0.7, 0.1, 2, 2.2);
        });
        break;
      case 'click':
        fmKeys(ctx, bus, mtof(84), t, 0.06, 0.04, 4, 0.4);
        break;
      case 'error':
        fmKeys(ctx, bus, mtof(48), t, 0.14, 0.06, 1.5, 0.5);
        break;
    }
  }
}
