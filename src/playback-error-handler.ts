import { getPlayerManager } from './player_api';
import type { EventMapOf, PlayerManager } from './player_api';

const playerManager = await getPlayerManager();

type EventMap = EventMapOf<PlayerManager>;

let currentVideo: HTMLVideoElement | null = null;

const VIDEO_ERROR_CODES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
};

function handleVideoError(this: HTMLVideoElement) {
  const err = this.error;
  if (err) {
    const codeName = VIDEO_ERROR_CODES[err.code] ?? `code ${err.code}`;
    console.error(
      `[playback-error-handler] Video element error: ${codeName} — ${err.message}`
    );
  } else {
    console.error('[playback-error-handler] Video element error: unknown');
  }
}

function handleVideoAbort(this: HTMLVideoElement) {
  console.warn('[playback-error-handler] Video playback aborted');
}

function handleVideoStalled(this: HTMLVideoElement) {
  console.warn('[playback-error-handler] Video playback stalled');
}

function attachVideoListeners(video: HTMLVideoElement) {
  video.addEventListener('error', handleVideoError);
  video.addEventListener('abort', handleVideoAbort);
  video.addEventListener('stalled', handleVideoStalled);
}

function detachVideoListeners(video: HTMLVideoElement) {
  video.removeEventListener('error', handleVideoError);
  video.removeEventListener('abort', handleVideoAbort);
  video.removeEventListener('stalled', handleVideoStalled);
}

function handleNewVideo(this: PlayerManager, _: EventMap['newVideo']) {
  if (currentVideo) {
    detachVideoListeners(currentVideo);
  }
  const video = document.querySelector('video');
  if (video) {
    currentVideo = video;
    attachVideoListeners(video);
  }
}

function handlePlaybackError(this: PlayerManager, _: EventMap['playbackError']) {
  const videoData = this.player.getVideoData();
  const playerState = this.player.getPlayerStateObject();

  const activeStates = (Object.entries(playerState) as [string, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');

  const videoErr = currentVideo?.error;
  const videoErrDesc = videoErr
    ? `${VIDEO_ERROR_CODES[videoErr.code] ?? `code ${videoErr.code}`}: ${videoErr.message}`
    : null;

  const parts = [
    `videoId=${videoData.video_id ?? 'unknown'}`,
    videoData.title ? `title="${videoData.title}"` : null,
    activeStates ? `playerState=[${activeStates}]` : null,
    videoErrDesc ? `videoError=${videoErrDesc}` : null
  ]
    .filter(Boolean)
    .join(' ');

  console.error(`[playback-error-handler] Player error state detected: ${parts}`);
}

playerManager.addEventListener('newVideo', handleNewVideo);
playerManager.addEventListener('playbackError', handlePlaybackError);
