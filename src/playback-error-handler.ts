import { getPlayerManager } from './player_api';
import type { EventMapOf, PlayerManager } from './player_api';

const playerManager = await getPlayerManager();

type EventMap = EventMapOf<PlayerManager>;

let currentVideo: HTMLVideoElement | null = null;

function handleVideoError(this: HTMLVideoElement) {
  const err = this.error;
  console.error(
    `[playback-error-handler] Video element error ${JSON.stringify(err ? { code: err.code, message: err.message } : null)}`
  );
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
  const videoErr = currentVideo?.error;

  const errorInfo = {
    videoId: videoData.video_id,
    title: videoData.title,
    playerState,
    videoError: videoErr ? { code: videoErr.code, message: videoErr.message } : null
  };

  // If there's no actual video element error (videoError is null) but the player
  // thinks there's an error, this is likely a false positive or a transient state.
  // This can happen due to SABR backoff or other temporary player issues.
  // Log at a lower level since there's no actual video element error.
  if (!videoErr) {
    console.warn(
      `[playback-error-handler] Player reported error state but no video element error detected ${JSON.stringify(errorInfo)}`
    );
    return;
  }

  // There's an actual video element error - log it as a real error
  console.error(
    `[playback-error-handler] Player error state detected with video element error ${JSON.stringify(errorInfo)}`
  );
}

playerManager.addEventListener('newVideo', handleNewVideo);
playerManager.addEventListener('playbackError', handlePlaybackError);
