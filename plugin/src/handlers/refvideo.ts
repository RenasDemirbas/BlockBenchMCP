// Video reference images (Blockbench 5.2 adds playback controls for them):
// seek, play/pause, mute and volume, and a status readout. Used by the
// reference_images handler in ./scene.
import { fail } from '../registry';

export function describeVideo(ref: any): any {
  const v: any = ref.video;
  if (!ref.is_video || !v) return undefined;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    duration: Number.isFinite(v.duration) ? round(v.duration) : null,
    time: round(v.currentTime),
    playing: !v.paused,
    muted: v.muted,
    volume: round(v.volume),
    sync_to_timeline: ref.sync_to_timeline !== false,
  };
}

/** Apply {time, playing, muted, volume} to a video reference. */
export async function applyVideoControls(ref: any, controls: any) {
  if (!controls) return;
  if (!ref.is_video || !ref.video) fail(`"${ref.name}" is an image, not a video — "video" controls only apply to mp4/mov/wmv references.`);
  const v: any = ref.video;
  if (controls.muted !== undefined) v.muted = !!controls.muted;
  if (controls.volume !== undefined) v.volume = Math.max(0, Math.min(1, Number(controls.volume)));
  if (controls.time !== undefined) {
    const t = Math.max(0, Number(controls.time));
    v.currentTime = Number.isFinite(v.duration) ? Math.min(t, v.duration) : t;
  }
  if (controls.playing === true) {
    // play() rejects when the browser blocks unmuted autoplay; report it instead of throwing.
    try { await v.play(); } catch (err: any) { fail(`"${ref.name}" could not start playing (${err?.message || err}). Retry with "muted": true.`); }
  } else if (controls.playing === false) {
    v.pause();
  }
}
