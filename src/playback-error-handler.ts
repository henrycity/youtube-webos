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

function handlePlaybackError(this: PlayerManager, event: EventMap['playbackError']) {
  const videoData = this.player.getVideoData();
  const playerState = this.player.getPlayerStateObject();
  const videoErr = currentVideo?.error;

  const errorInfo = {
    videoId: videoData.video_id,
    title: videoData.title,
    playerState,
    videoError: videoErr ? { code: videoErr.code, message: videoErr.message } : null
  };

  // Log the event object from the callback for debugging
  console.error(
    `[playback-error-handler] Playback error event ${JSON.stringify({
      type: event.type,
      detail: event.detail,
      currentTarget: event.currentTarget?.constructor?.name ?? null
    })}`
  );

  // If there's no actual video element error (videoError is null) but the player
  // thinks there's an error, this is likely a false positive caused by SABR backoff.
  // Attempt recovery by clearing the video element's error state and resuming playback.
  if (!videoErr) {
    console.warn(
      `[playback-error-handler] Player reported error state but no video element error detected ${JSON.stringify(errorInfo)}`
    );
    
    // Attempt recovery: reload the video element to clear the error state
    // This helps recover from SABR backoff false positives
    if (currentVideo && !currentVideo.paused) {
      try {
        console.info('[playback-error-handler] Attempting to recover from false positive error by reloading video element');
        const currentTime = currentVideo.currentTime;
        currentVideo.load(); // Clear the error state
        currentVideo.currentTime = currentTime;
        currentVideo.play().catch(() => {
          // Play might fail if already playing, ignore
        });
      } catch (err) {
        console.warn('[playback-error-handler] Recovery attempt failed:', err);
      }
    }
    return;
  }

  // There's an actual video element error - log it as a real error
  console.error(
    `[playback-error-handler] Player error state detected with video element error ${JSON.stringify(errorInfo)}`
  );
}

playerManager.addEventListener('newVideo', handleNewVideo);
playerManager.addEventListener('playbackError', handlePlaybackError);
